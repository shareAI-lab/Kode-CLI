# 故障复盘：print 模式预算/轮次上限错误以 0 退出、语音发送中可被"取消"关闭、MCP 导入成功文案与作用域不符

## 基本信息

| 字段          | 内容                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------- |
| 日期          | 2026-08-14                                                                                |
| 发现人        | 代码审计                                                                                  |
| 严重程度      | P1-严重（退出码）；P2-一般（反馈误导）                                                    |
| 影响范围      | `kode --print/--headless` 文本模式、`/voice` 提交状态、`kode mcp add-from-claude-desktop` |
| 关联 Issue/PR | 未关联                                                                                    |
| 关联提交      | 当前工作区未提交                                                                          |

## 1. 问题描述

### 1.1 问题场景

三个独立的交互反馈问题：

1. **退出码**：`kode --print --max-budget-usd 1 "..."` 或 `--max-turns 2` 触发上限时，文本模式向 stdout 输出 `Error: Exceeded USD budget (...)` / `Error: Reached max turns limit (...)`，却以 `process.exit(0)` 结束。
2. **语音发送中可被"取消"关闭**：`/voice` 在 `submitting` 状态（已把转录文本交给 `submission.submit()`，如跨会话消息投递）按下 Esc/Ctrl+C，界面关闭并提示可取消，但发送并未被中止，转录文本仍会到达目的地。
3. **误导性文案**：`kode mcp add-from-claude-desktop --scope global` 导入成功后提示 `Imported N servers to local config.`，实际写入的是用户级（global）配置。

### 1.2 具体表现

- 脚本/CI 无法区分"预算/轮次超限被截断"与"成功完成"：stdout 出现 `Error:` 前缀文本但退出码为 0。
- 用户以为取消了语音消息，消息仍被投递；且投递结果（如 messageId）被静默丢弃。
- 导入成功的提示与实际写入的配置作用域不一致。

### 1.3 错误信息

- `Error: Exceeded USD budget (1)` 后接 `process.exit(0)`（`runPrintMode.ts`）。
- 语音发送中 controls 行显示 `Esc/Ctrl+C cancels and closes`，但 `close()` 不取消 `submission.submit`。
- `Imported 3 servers to local config.`（`--scope global` 时）。

## 2. 临时解决方案

未采用临时绕过；均按根因直接修复。

## 3. 根本原因分析

### 3.1 问题分析过程

1. 文本模式下，预算/轮次上限被当成"正常终止"处理：`runPrintMode.ts` 三处错误分支只改了输出文本，未同步退出码；而同一个文件里真正的执行错误（`Execution error`）路径是 `exit(1)`，可对照。
2. `VoiceScreen` 的 Esc 分支对 `submitting` 没有独立处理：`transcribing` 可中止（有 AbortController），而 `submitting` 的 `submission.submit` 没有取消信号，却走了统一的 `close()`。
3. `importClaudeDesktop.tsx` 的成功文案硬编码 `local config`，未使用实际 `scope`。

### 3.2 直接原因

- `runPrintMode.ts:287,315,326`：`process.exit(0)` 应为 `process.exit(1)`。
- `VoiceScreen.tsx`：Esc/Ctrl+C 处理缺少 `submitting` 状态守卫；controls 文案也承诺了不存在的取消能力。
- `importClaudeDesktop.tsx:246`：成功消息未根据 `scope` 生成。

### 3.3 根本原因

- **设计层面**：文本模式把"达到上限"与"成功"共用退出码 0，与错误文本和 telemetry 的 `error_max_budget_usd` / `error_max_turns` 子类型相矛盾。
- **开发层面**：`submitting` 被误当作可取消状态处理，未区分"可中止的异步（转写）"与"不可中止的投递（发送）"。
- **流程层面**：MCP 导入文案未做作用域参数化。

### 3.4 为什么没有提前发现

- 预算/轮次路径依赖真实引擎触发，测试只覆盖了 `stream-json` 协议路径（`is_error` 语义），未覆盖文本模式退出码。
- 语音发送状态需要先完成录音/转写才能到达，缺乏针对 `submitting` 的按键回归用例。

## 4. 解决方案

### 4.1 根本解决方案

- `runPrintMode.ts`：文本模式三处上限错误分支改为 `process.exit(1)`（与错误文本、telemetry 错误子类型一致）；成功路径保持 `exit(0)`。
- `VoiceScreen.tsx`：新增 `__canCloseVoiceScreenOnEscapeForTests`，`submitting` 状态下吞掉 Esc/Ctrl+C（发送不可中止，关闭会静默丢弃结果）；controls 文案改为 `Sending… please wait — the send cannot be cancelled once started`。
- `importClaudeDesktop.tsx`：新增 `__scopeDisplayForImportForTests`，成功消息按实际 scope 显示（project→local、global→user、mcpjson→project、mcprc→mcprc）。

**修改文件**：

- `apps/cli/src/entrypoints/cli/print/runPrintMode.ts`
- `apps/cli/src/ui/screens/overlays/VoiceScreen.tsx`
- `apps/cli/src/entrypoints/cli/commands/mcp/importClaudeDesktop.tsx`

### 4.2 影响范围评估

- 仅改变文本模式（`--output-format text`）的退出码；`stream-json`/`json` 的 SDK 协议 `is_error` 语义保持不变（`runSingleTurn.ts` 未改动）。
- 语音仅在发送不可中止的极短窗口内禁用 Esc/Ctrl+C；转写中止行为不变。
- MCP 导入文案仅文案变化，无行为变化。

## 5. 预防措施

### 5.1 代码层面

- [x] 文本模式错误分支与 `process.exit(1)` 保持一致。
- [x] 区分"可中止"与"不可中止"的异步状态，不可中止时禁止关闭并如实提示。

### 5.2 测试层面

- [x] `runPrintMode.test.ts`：预算超限（返回值路径与抛错路径）断言首个 `process.exit` 调用为 1；成功路径为 0。
- [x] `VoiceScreen.test.ts`：`submitting` 状态 Esc 不可关闭；其余状态可关闭。
- [x] `importClaudeDesktop.test.ts`：scope→显示名映射。

### 5.3 监控层面

- [ ] 后续可在 headless telemetry 中记录 `exit_code` 字段以便核对。

### 5.4 流程/规范层面

- [ ] 新增 CLI 命令时检查所有错误分支的退出码与输出文本、telemetry 子类型一致。
- [ ] 凡 UI 文案承诺"取消"，须确认对应副作用可真正中止。

## 6. 经验总结（一句话）

错误文本、telemetry 子类型与进程退出码必须同源一致，且界面不得承诺无法兑现的"取消"。
