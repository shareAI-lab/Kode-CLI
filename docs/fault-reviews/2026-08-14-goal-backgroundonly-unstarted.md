# 故障复盘：pollDueSchedule 的 unstarted 分支绕过 backgroundOnly 门禁

## 基本信息

| 字段          | 内容                                       |
| ------------- | ------------------------------------------ |
| 日期          | 2026-08-14                                 |
| 发现人        | 代码审计（goal 调度运行态）                |
| 严重程度      | P3-轻微（当前可达性低，契约不一致）        |
| 影响范围      | daemon 后台会话调度（backgroundOnly 路径） |
| 关联 Issue/PR | 未关联                                     |
| 关联提交      | 当前工作区未提交                           |

## 1. 问题描述

### 1.1 问题场景

detached/后台 host（daemon 中 `isDetachedBackgroundSession` 判定、`backgroundOnly: true` 轮询）对一个已由直接 `/goal` 启动（`startGoal` 立即 claim、`turnCount === 0`）的一次性 run 轮询。

### 1.2 具体表现

`pollDueSchedule` 的 claim 分支受 `backgroundOnly` 过滤（只 claim 显式 `backgroundKeepAlive` 的 interval goal），但其后的 **unstarted 再暴露分支没有该过滤**：任何 `running && kind==='once' && turnCount===0` 的 run 都会被再暴露给后台 host。`types.ts` 对 `backgroundOnly` 的文档语义是"将 detached host 限制为显式 opt-in 后台 keep-alive 的 goal"，unstarted 分支绕过该限制，与文档契约不一致。

### 1.3 错误信息

无异常；表现为后台 host 可能把本不该由它派发的一次性 run 派发到 daemon 会话。

## 2. 临时解决方案

无。

## 3. 根本原因分析

### 3.1 问题分析过程

1. 阅读 `pollDueSchedule`：claim 分支（`claimDueSchedulesUnlocked`）在候选过滤与 mutate 复核中都检查 `input.backgroundOnly && !isBackgroundKeepAliveGoal(...)`。
2. unstarted 分支只检查 `status / kind / turnCount / lease`，没有 `backgroundOnly` 判定——一次 `startGoal`（one-off，非 background）在该会话上即满足再暴露条件。
3. 对比 REPL 侧行为：REPL 通过 `dispatchedUnstartedGoalRunIdsRef` 按 runId 去重，daemon runner 无去重；runner 的兜底是 dispatch 结束后 `releaseAfterTurn` 将 once run pause，所以实际重复派发的窗口被压缩，但"后台 host 读取了非后台 run"的契约违背仍然存在。
4. 可达性评估：daemon 会话（`isDetachedBackgroundSession` 需同时满足 `clients.size === 0` 与 backgroundLoopSessions 命中）当前不会有 `startGoal` 产生的 once run（server 侧创建走 control plane 的 `createScheduledForControlPlane`，CLI 的 `startGoal` 使用 CLI 自己的 sessionId），因此判定为低风险、但确属真实契约缺陷。

### 3.2 直接原因

`pollDueSchedule` 的 unstarted 分支漏写 `input.backgroundOnly` 过滤。

**相关代码位置**：`packages/goals/src/service.ts:864-884`（unstarted 分支）

**关键代码片段**（修改前）：

```ts
if (
  !active ||
  active.status !== 'running' ||
  active.schedule.kind !== 'once' ||
  active.activeRun?.turnCount !== 0 ||
  active.lease?.runId !== active.activeRun.id
) {
  return null
}
```

### 3.3 根本原因

- **设计层面**：`backgroundOnly` 的语义被表述为"限制 detached host 能 claim 的 goal"，但 unstarted 分支的定位是"再暴露已 claim 的 run"，设计时只对齐了 claim 路径，漏掉了再暴露路径。
- **开发层面**：两个分支共用同一个 flag 输入，但只有其中一个消费了它。

### 3.4 为什么没有提前发现

- 现有测试只覆盖了 claim 路径的 backgroundOnly 过滤（`detached sessions claim only explicit background keep-alive loops`），未构造"先 startGoal、再 backgroundOnly 轮询"的用例。

## 4. 解决方案

### 4.1 根本解决方案

给 unstarted 分支加上与 claim 分支一致的 `backgroundOnly` 判定：

**修改文件**：`packages/goals/src/service.ts:864-884`

**修改后**：

```ts
if (
  !active ||
  active.status !== 'running' ||
  active.schedule.kind !== 'once' ||
  (input.backgroundOnly && !isBackgroundKeepAliveGoal(active)) ||
  active.activeRun?.turnCount !== 0 ||
  active.lease?.runId !== active.activeRun.id
) {
  return null
}
```

由于 `isBackgroundKeepAliveGoal` 要求 `kind === 'interval'`，而 unstarted 分支要求 `kind === 'once'`，该过滤在 `backgroundOnly` 时恒为 true——即后台 host 永不再暴露一次性 run，与"detached host 只处理显式后台 loop"的契约一致。

新增回归测试 `does not surface unstarted direct runs to a background-only poller`：`startGoal` 后 `backgroundOnly: true` 轮询返回 null，普通轮询仍返回 unstarted。

### 4.2 影响范围评估

- 仅影响带 `backgroundOnly` 的轮询（daemon detached 会话）；REPL 与普通 daemon 会话不传该 flag，行为不变。

## 5. 预防措施

### 5.1 代码层面

- [ ] 同一输入 flag 在不同分支（claim / 再暴露）必须一致消费；新增分支时检查同函数内已有过滤条件。
- [ ] 审计所有 `ClaimDueSchedulesInput` 字段的使用点是否两两一致。

### 5.2 测试层面

- [ ] 补充"直接启动 + backgroundOnly 轮询"的组合用例（已补）。

## 6. 经验总结（一句话）

> 同一门禁 flag 必须在同一函数的每一条暴露路径上生效，否则"限制范围"的承诺会从漏掉的路径泄漏。
