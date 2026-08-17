# 故障复盘：只读代码探索被误判为未验证的工作区修改

## 基本信息

| 字段          | 内容                                                       |
| ------------- | ---------------------------------------------------------- |
| 日期          | 2026-08-12                                                 |
| 发现人        | 用户反馈                                                   |
| 严重程度      | P1-严重                                                    |
| 影响范围      | CLI 交互完成门禁、Task/Explore 子代理、后台 Bash、会话恢复 |
| 关联 Issue/PR | 无                                                         |
| 关联提交      | 工作区修改，尚未提交                                       |

## 1. 问题描述

### 1.1 问题场景

用户只要求读取代码并分析终端关闭后的后台运行能力。模型调用 `Task(subagent_type: Explore)`，子代理只执行 Read、Glob、Grep 等读取操作，主模型正常结束回答。

### 1.2 具体表现

完成门禁把 `Task` 当成可能修改代码的未知工具，强制要求测试；模型没有理由在纯读取任务后运行测试，因此最终回答被替换为错误提示，用户无法获得已经完成的分析结果。

后台 Bash 与子代理失败还存在两个相邻风险：后台命令启动后尚未完成时可能被错误判断为“没有修改”，子代理因未验证修改失败时父代理可能仍显示“完成”。

### 1.3 错误信息

**告警信息**：

```text
API_ERROR: Workspace changes were made, but the model stopped without recording a trusted test, typecheck, lint, build, or check result after the latest change.
```

**日志信息**：

```text
用户请求 -> Task(Explore) -> TaskOutput -> Read/Glob/Grep -> 正常回答
没有 Write/Edit/ApplyPatch，也没有会写入工作区的 Bash 命令。
```

## 2. 临时解决方案

### 2.1 方案描述

用户可以重试并显式说明“只读，不要要求测试”，但该方式不能改变引擎的错误分类。

### 2.2 止血效果

无法可靠止血。同一工具序列仍可能触发完成门禁。

### 2.3 临时方案的局限

问题位于引擎的可信证据判定，不应要求用户通过提示词绕过产品缺陷。

## 3. 根本原因分析

### 3.1 问题分析过程

1. 从真实会话 JSONL 还原工具序列，确认任务只有 Explore、Read、Glob、Grep，没有文件写入。
2. 检查 Task 定义，确认 `TaskTool.isReadOnly()` 返回 `true`，Explore 内置代理也受只读工具策略约束。
3. 检查完成门禁的证据扫描，发现其维护了另一份硬编码的“非修改工具名”列表；列表遗漏 `Task`，且没有读取工具自己的元数据。
4. 扩展排查到 Bash，发现常见的 `rg`、`sed -n`、只读管道也会被保守地当成写入，造成同类误判和不必要的串行执行。
5. 扩展排查到后台执行，发现启动结果在进程真正完成前返回；仅在工具调用前后观察工作区会漏掉之后发生的写入。
6. 扩展排查到子代理，发现子代理最后一条消息即使是失败消息，Task 仍可能包装成 `completed`，父代理无法接管未验证的部分修改。
7. 最终定位为：权限只读性、工作区修改归属、后台生命周期和验证证据被混在一个工具名猜测中，缺少引擎生成且可持久化的结果级回执。

### 3.2 直接原因

**相关代码位置**：`packages/engine/src/verification/evidence.ts`

完成门禁根据工具名称维护独立白名单。未命中的工具一律视为修改工具，因此 `Task` 即使实际运行 Explore 也会触发门禁。

### 3.3 根本原因

- **设计层面**：`isReadOnly` 同时承载权限、并发和工作区修改语义；应用状态变化与项目文件写入没有分离。
- **开发层面**：工具执行结果没有记录“本次调用是否实际改变工作区”的可信元数据，证据扫描只能二次猜测。
- **流程层面**：原测试主要覆盖 Write 后需要验证，没有覆盖纯探索、拒绝执行、后台完成、子代理失败和会话重载。

### 3.4 为什么没有提前发现

- 代码审查阶段：两个独立的工具分类来源看起来都合理，但没有一致性约束。
- 测试阶段：缺少真实的 Explore 会话回归样例和结果级修改回执测试。
- 监控告警：错误统一使用 API error 通道，难以区分供应商 API 故障和本地验证门禁故障。

## 4. 解决方案

### 4.1 根本解决方案

**修改文件**：

- `packages/tool-interface/src/Tool.ts`
- `packages/engine/src/verification/mutation.ts`
- `packages/engine/src/verification/workspaceFingerprint.ts`
- `packages/engine/src/pipeline/tool-call.ts`
- `packages/engine/src/verification/evidence.ts`
- `packages/engine/src/verification/receipt.ts`
- `packages/permissions/src/bash/readOnly.ts`
- `packages/tools/src/tools/ai/TaskTool/*`
- `packages/tools/src/tools/system/TaskOutputTool/TaskOutputTool.tsx`
- `packages/protocol/src/utils/kodeAgentSessionLog.ts`
- `packages/protocol/src/utils/kodeAgentSessionLoad.ts`

**修改前**：

```ts
const isMutation = !NON_MUTATING_TOOL_NAMES.has(toolName)
```

**修改后**：

```ts
type WorkspaceMutationScope = 'none' | 'direct' | 'delegated'

type WorkspaceMutationReceipt = {
  version: 1
  toolUseId: string
  scope: WorkspaceMutationScope
  basis: 'declared' | 'observed' | 'delegated'
}
```

**方案说明**：

1. 工具可以声明工作区修改归属；Task、Skill、SlashCommand 的子执行由子管线负责验证。
2. 直接写入工具在调用前后采集 Git 工作区指纹，实际无变化时不会触发无意义验证；无法观察时仍保持 fail-closed。
3. 引擎把结果级修改回执写入工具结果元数据，证据扫描优先信任引擎回执，旧会话仍使用保守回退规则。
4. 后台 Bash 启动标记为 delegated；TaskOutput 取得终态后根据原命令生成修改回执或可信验证回执。
5. 子代理 API/验证失败返回 `failed`；父层接管可能遗留的修改并继续验证。
6. 扩充只读 Shell 解析，同时拒绝重定向、原地编辑、外部 diff、输出文件、exec/filter 等隐式写入或执行选项。
7. 修改回执独立持久化到 JSONL，恢复会话后不会丢失判定依据。
8. 用户提示改为明确区分“验证未完成”和“当前没有可信执行工具”，不再把本地门禁描述成供应商 API 故障。

### 4.2 影响范围评估

修改影响完成门禁、工具调度并发、后台任务取回和会话加载。未知工具与无法观察的环境仍按 direct 处理，安全策略保持 fail-closed。Git 指纹忽略仅有暂存区变化，避免 `git add` 使已经完成的源代码测试失效；它使用文件元数据检测常规编辑，不承担内容审计或恶意绕过防护。

## 5. 预防措施

### 5.1 代码层面

- [x] 将工作区修改语义从通用 `isReadOnly` 中分离。
- [x] 所有结果级判定由引擎签发回执，未知工具保持 fail-closed。
- [x] 后台启动与后台终态使用不同的归属和证据。

### 5.2 测试层面

- [x] 增加 Task/Explore 纯读取不触发门禁的回归测试。
- [x] 增加拒绝执行、调用中断、无操作写工具和子代理失败测试。
- [x] 增加后台验证状态、工作区指纹、JSONL 持久化与恢复测试。
- [x] 增加复合只读 Shell 和隐式写入参数测试。

### 5.3 监控层面

- [ ] 后续为本地验证门禁增加独立事件类型和计数，避免与供应商 API 错误混合统计。

### 5.4 流程/规范层面

- [x] 修改工具或代理生命周期时，必须同时检查前台、后台、失败、取消、恢复五条路径。
- [ ] 新增工具时要求显式声明工作区修改归属，逐步移除工具名回退列表。

## 6. 经验总结（一句话）

> 是否需要验证必须由实际工作区影响和执行生命周期决定，不能从工具名称或“修改了应用状态”推断为“修改了项目代码”。
