# 故障复盘：daemon GoalScheduleRunner 的 tick 异常成为未处理拒绝导致进程退出

## 基本信息

| 字段          | 内容                             |
| ------------- | -------------------------------- |
| 日期          | 2026-08-14                       |
| 发现人        | 代码审计（goal 调度运行态）      |
| 严重程度      | P1-严重                          |
| 影响范围      | daemon 服务器进程（apps/server） |
| 关联 Issue/PR | 未关联                           |
| 关联提交      | 当前工作区未提交                 |

## 1. 问题描述

### 1.1 问题场景

`GoalScheduleRunner.start()` 用 `setInterval` 每 1s 调用 `void this.tick()`，`tick()` 内部任何同步异常（存储 IO 失败、锁竞争超时、sessionId 非法等）都会使该 Promise 拒绝，而调用方没有 `.catch()`。

### 1.2 具体表现

Bun 运行时对未处理的 Promise 拒绝默认直接终止进程（实测 `bun run` 下未捕获拒绝 exit=1）。一次瞬时的 goal 存储锁获取失败（默认 20 次重试 × 15ms ≈ 300ms 窗口超时）或磁盘错误即可让整个 daemon 进程退出，所有已连接的 WebSocket 会话随之断开。

### 1.3 错误信息

```
error: Error: Failed to acquire goal store lock: <goalsDir>/.scope-<hash>.lock
（Bun 打印未处理拒绝并 exit=1）
```

## 2. 临时解决方案

无（崩溃即恢复策略，重启后由租约恢复路径重新拉起）。

## 3. 根本原因分析

### 3.1 问题分析过程

1. 定位到 `apps/server/src/automation/goalScheduleRunner.ts` 的 `start()`：定时器回调 `void this.tick()` 无 `.catch`。
2. 追踪 `tick()` 的同步异常来源：`this.scheduler.tick()` → `service.pollDueSchedule()` → `cleanText(sessionId)`（空串抛错）、`withScopeLock()` → `acquireLock()`（重试耗尽抛错）、`mutateGoal()` 内 `atomicWriteText`（磁盘错误）。
3. 对比 REPL 侧 `useReplController.tsx` 的 tick：外层 `try/catch (logError)` 包裹；而 daemon 侧没有等价保护。
4. 实测 Bun 对未处理拒绝的行为：`Promise.reject` 未捕获 → 进程 exit=1。确认这是真实的进程级风险。
5. 另外确认 `start()` 首次立即调用的 `void this.tick()` 同样无保护。

### 3.2 直接原因

`start()` 中 `void this.tick()` 未捕获拒绝；`tick()` 的 `finally` 只复位 `ticking`，不消费异常。

**相关代码位置**：`apps/server/src/automation/goalScheduleRunner.ts:52-56`（start 定时器与首 tick）

**关键代码片段**：

```ts
this.timer = setInterval(() => {
  void this.tick() // 无 .catch：拒绝即未处理
}, this.pollIntervalMs)
this.timer.unref?.()
void this.tick() // 同样无保护
```

### 3.3 根本原因

- **设计层面**：`tick()` 被设计成"fire-and-forget"，但契约上没有明确错误由谁消费。
- **开发层面**：dispatch 的异步错误用了 `.then(onSuccess, onError)` + `Promise.allSettled` 兜底，却漏掉了调度/存储环节的同步异常；测试只覆盖了 dispatch 失败，未覆盖 poll 失败。
- **流程层面**：缺少"定时器回调内调用必须吞掉异常"的约定。

### 3.4 为什么没有提前发现

- 测试环境 storage 无并发竞争、无磁盘错误，锁获取恒成功。
- REPL 侧有 try/catch，给人"已有保护"的错觉，daemon 侧被忽略。

## 4. 解决方案

### 4.1 根本解决方案

在 `tick()` 内捕获整体异常并路由到 `onError`，使 `tick()` 永不拒绝（`finally` 仍复位 `ticking`）：

**修改文件**：`apps/server/src/automation/goalScheduleRunner.ts:114-121`

**修改后**：

```ts
} catch (error) {
  // A claim/storage failure must never escape as an unhandled rejection:
  // `start()` fires `void this.tick()` from a timer, and Bun terminates
  // the process on an unhandled rejection. Route the failure to the
  // host's error sink instead of killing the daemon.
  this.options.onError?.(error)
} finally {
  this.ticking = false
}
```

**方案说明**：选择在 `tick()` 内部消化异常（而非在 `start()` 加 `.catch`），使"调用方无需关心 tick 是否会拒绝"成为类型层面的不变式；`ticking` 由 `finally` 保证复位，下次定时器触发仍可继续。`onError` 为可选回调，默认无副作用。

### 4.2 影响范围评估

- 行为变化：`tick()` 不再向外抛错，改为回调 `onError`（生产 server.ts 未传 `onError`，即静默吞掉并继续下一 tick）。
- 与 REPL 侧行为对齐（REPL 也是 logError 后继续）。
- 新增回归测试 `routes tick failures to onError instead of rejecting`（构造空白 sessionId 使 poll 抛错，断言 `await runner.tick()` 不拒绝且 onError 收到错误）。

## 5. 预防措施

### 5.1 代码层面

- [ ] 定时器回调内发起的 fire-and-forget Promise 必须 `.catch` 或在函数内消化，禁止裸 `void promise()`。
- [ ] 审查其他 `void this.xxx()` 调用点（如 REPL、hook 系统）是否有同类未处理拒绝。

### 5.2 测试层面

- [ ] GoalScheduleRunner 补充"poll 阶段抛错"的回归测试（已补）。
- [ ] 补一条锁竞争超时场景的集成测试（多进程并发 claim 时存储抛错）。

### 5.3 监控层面

- [ ] daemon 增加 `onError` 接线与错误计数指标，避免静默吞错。

## 6. 经验总结（一句话）

> fire-and-forget 的异步入口必须保证 Promise 永不拒绝；Bun 会把未处理拒绝升级为进程退出。
