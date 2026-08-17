# 故障复盘：goal 状态机 fencing 检查顺序错误导致过期 run 的收尾调用抛异常

## 基本信息

| 字段          | 内容                                                        |
| ------------- | ----------------------------------------------------------- |
| 日期          | 2026-08-14                                                  |
| 发现人        | 代码审计（goal 调度运行态）                                 |
| 严重程度      | P2-一般（竞态窗口窄，但为未捕获异常）                       |
| 影响范围      | `evaluateActiveGoalAfterTurn` / GoalScheduleRunner 收尾路径 |
| 关联 Issue/PR | 未关联                                                      |
| 关联提交      | 当前工作区未提交                                            |

## 1. 问题描述

### 1.1 问题场景

一个 GoalRun 的租约过期后被 `recoverInterruptedGoals` 恢复为 `scheduled`（或该 goal 已被并发 actor 完成/取消），此时旧 run 的收尾调用（`completeGoal`/`pauseGoal`/`failGoal`/`releaseAfterTurn` 携带旧 `runId`）触发。

### 1.2 具体表现

`GoalService.transition()` 先做转移表校验、后做 runId fencing 校验。goal 一旦离开 `running`（恢复成 `scheduled`、或已 `completed`/`cancelled`），旧 run 的 fenced 调用会命中非法转移分支并**抛出未捕获异常**，而不是按 fencing 契约返回 `null` 走 `staleResult()` 静默路径。`evaluateActiveGoalAfterTurn` 的决策应用处没有 try/catch，异常会穿透到 `message-pipeline` 使整个 turn 报错；runner 侧则被 `Promise.allSettled` 吞掉（错误丢失且 `onError` 不触发）。

### 1.3 错误信息

```
Error: Goal <id> cannot transition from scheduled to completed.
  at GoalService.transition ... (未捕获，穿透到 message-pipeline)
```

## 2. 临时解决方案

无。

## 3. 根本原因分析

### 3.1 问题分析过程

1. 审计 `transition()` 写路径：mutator 内先 `transitionAllowed(current.status, target)`（非法即 throw），后校验 `options.runId` 与 `lease.runId`/`activeRun.id`（不匹配返回 null）。
2. 追踪 `evaluateActiveGoalAfterTurn`：`findActiveGoal` 在 await evaluator **之前**读取 goal，之后 `completeGoal`/`pauseGoal` 用**旧快照的 runId** 调用；若 evaluator 期间 goal 被恢复/完成/取消，状态已离开 `running`。
3. 对照 `types.ts` 的 fencing 契约："Callers ... must return this runId as a fencing token so an expired/reclaimed run cannot mutate its successor"——过期 run 的收尾应为 no-op，而非把"状态机转移非法"当成编程错误抛出。
4. 对照 `recordContinuation`：它先查 `status !== 'running'` 直接返回 null（优雅），而 `transition()` 系的四个方法会 throw——行为不一致，`staleResult()` 分支实际上永远走不到。
5. 确认既有测试 `rejects invalid state transitions` 固化了旧顺序（fenced 调用在非 running 状态抛错），需要一并修正断言。

### 3.2 直接原因

`transition()` 中 fencing 校验位于转移表校验之后：goal 离开 `running` 后，fenced 调用先命中非法转移而抛错，fencing 的 no-op 语义被短路。

**相关代码位置**：`packages/goals/src/service.ts:354-371`（transition mutator）

**关键代码片段**（修改前）：

```ts
const changed = this.storage.mutateGoal(goalId, current => {
  if (!transitionAllowed(current.status, target)) {   // ① 先抛
    throw new Error(`Goal ${current.id} cannot transition from ${current.status} to ${target}.`)
  }
  if (options.runId && (current.lease?.runId !== options.runId ||
      current.activeRun?.id !== options.runId)) {    // ② 后 null
    return null
  }
  ...
```

### 3.3 根本原因

- **设计层面**：转移表"非法即抛"是防御性设计，但 fencing 契约要求"过期/reclaimed run 不得变更后继"，两者在 goal 离开 running 时语义冲突；fencing 应优先。
- **开发层面**：`staleResult()` 机制暗示了预期行为（stale 应静默返回），但 transition 系的 throw 使该机制不可达。
- **测试层面**：原测试把"带错 runId 对 scheduled goal 调 completeGoal 抛错"固化为预期，与契约文档矛盾。

### 3.4 为什么没有提前发现

- 单元测试覆盖了"goal 仍为 running 但 runId 被换"（reclaimed）场景——此时转移表校验通过，两种顺序结果相同；未覆盖"goal 已离开 running"场景。
- 竞态窗口窄（需要 evaluator 期间 lease 过期或并发收尾），集成测试难复现。

## 4. 解决方案

### 4.1 根本解决方案

把 runId fencing 校验移到转移表校验之前：fenced 调用一旦发现 runId 不匹配（含 lease 已被清空、goal 已恢复/完成等所有"离开 running"形态）立即返回 null；转移表仍对**无 fencing** 的非法转移抛错。

**修改文件**：`packages/goals/src/service.ts:354-371`

**修改后**：

```ts
const changed = this.storage.mutateGoal(goalId, current => {
  if (options.runId &&
      (current.lease?.runId !== options.runId ||
       current.activeRun?.id !== options.runId)) {
    // 过期/被替换的 run 收尾必须是 no-op，先于转移表校验。
    return null
  }
  if (!transitionAllowed(current.status, target)) {
    throw new Error(`Goal ${current.id} cannot transition from ${current.status} to ${target}.`)
  }
  ...
```

同时更新 `goals.test.ts` 中 `rejects invalid state transitions` 的首条断言（fenced 调用改断言为 `null`），并新增回归测试 `treats fenced mutations on a recovered goal as stale no-ops`：恢复后旧 runId 的 `completeGoal`/`pauseGoal` 返回 null、goal 保持 scheduled、恢复的 retry 槽仍可被新 run claim。

**方案说明**：fencing 通过时 goal 必为 `running`（持久化层强制 running 才有 lease/activeRun），因此"fencing 优先"不会放行任何非法转移；`cancelGoal`/`resumeGoal` 等无 runId 调用不受影响，仍对非法转移抛错，保留"拒绝静默损坏状态"的防御意图。

### 4.2 影响范围评估

- 行为变化仅限"携带 runId 的调用遇到已离开 running 的 goal"：由抛错变为返回 null。受影响调用方 `evaluateActiveGoalAfterTurn`（进入 `staleResult()`）与 runner 收尾（无操作），均为更符合契约的降级。
- 既有测试 `fences a stale evaluator from completing a reclaimed GoalRun`（goal 仍 running、runId 被换）两种顺序下结果一致，不受影响。

## 5. 预防措施

### 5.1 代码层面

- [ ] 状态机写路径统一约定：fenced 调用的 no-op 判定必须先于转移合法性判定。
- [ ] 在 `transition()` 增加注释说明校验顺序的理由。

### 5.2 测试层面

- [ ] 补充"goal 离开 running 后 fenced 收尾"回归测试（已补）。
- [ ] 补充 awaiting_approval 状态下 fenced 调用返回 null 的用例。

### 5.3 流程/规范层面

- [ ] 状态机契约文档明确：runId fencing 使过期 run 的收尾静默失效，非法转移的抛错仅针对无 fencing 调用。

## 6. 经验总结（一句话）

> fencing 校验必须先于状态机转移校验：过期 run 的收尾应是 no-op 而不是异常，否则 staleResult 兜底永远不可达。
