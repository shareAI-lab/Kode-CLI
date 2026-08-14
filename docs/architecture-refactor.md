# Core 拆分进展(Strangler Fig)

> 维护日期:2026-08-14。目标:`packages/core`(原 107K 行)按领域边界渐进拆分为独立
> workspace 包,每步保持 `tsc --noEmit`、相关测试、`build-cli.mjs` 全绿。

## 拆分模式(先例)

1. `git mv packages/core/src/<domain> packages/<name>/src`
2. 新建 `packages/<name>/package.json`(`"private": true`,`main/types` 指向 `src/index.ts`,
   声明 workspace 依赖)
3. 根 `tsconfig.json` `paths`:
   - 旧 alias(如 `#core/goals`)添加指向新位置的具体条目,**必须放在 `#core/*` 通配之前**
   - 新增规范别名 `@kode/<name>`
4. 旧引用(`#core/<name>` / `@kode/core/<name>`)保持兼容;新代码优先用 `@kode/<name>`
5. esbuild(`build-cli.mjs`)经 tsconfig paths 解析,alias 兼容即可打包

## 已完成

| 日期       | 包                  | 行数  | 说明                                                                                                                                                                                                                                 |
| ---------- | ------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-08-14 | `@kode/goals`       | 4,055 | 调度域:GoalService/scheduler/storage/controlPlane;service.ts 控制面拆为独立模块                                                                                                                                                      |
| 2026-08-14 | `@kode/tasks`       | 1,450 | 后台任务注册表与输出存储                                                                                                                                                                                                             |
| 2026-08-14 | `@kode/automation`  | 2,810 | taskGraph/supervisor/agentOrchestration/workspaceLease                                                                                                                                                                               |
| 2026-08-14 | `@kode/memory`      | 2,685 | 跨会话记忆(memory)+ 项目学习(projectLearning)+ projectScope,共享 JSONL/redaction 栈                                                                                                                                                  |
| 2026-08-14 | `@kode/runs`        | 702   | durable runs 历史与 telemetry                                                                                                                                                                                                        |
| 2026-08-14 | `@kode/sandbox`     | 1,957 | bwrap/seccomp 沙箱;W1-W5 全部解耦完成,**零 core 依赖叶子包**                                                                                                                                                                         |
| 2026-08-14 | `@kode/plan`        | 875   | plan 模式(state/paths/slug/reminders/systemPrompt);发现环两侧均为转发薄壳(legacyEnv→config、getKodeBaseDir→dataRoots、getOriginalCwd→runtime/cwd、Tool→tool-interface),直接断环拆包,`utils/planMode.ts` 转发壳改指 `@kode/plan/mode` |
| 2026-08-14 | `@kode/worktrees`   | 447   | git worktree 管理                                                                                                                                                                                                                    |
| 2026-08-14 | `@kode/checkpoints` | 688   | 会话检查点与 git 快照                                                                                                                                                                                                                |

> `packages/core` 规模:107,389 → 91,703 行(-15,686,14.6%)。
> 评估结论:worktrees/checkpoints 零风险直拆;memory 与 projectLearning 合并(孪生
> JSONL 栈共享 redaction/jsonlWriter);runs 依赖 memory/redaction 经 alias 兼容;
> sandbox 有条件拆(3 个假依赖 + 1 条 core→sandbox 反向边,接受软循环);plan 因
> 双向依赖环暂缓。
>
> 第二阶段:plan 的"双向依赖环"经核实两侧均为转发薄壳(compat/legacyEnv →
> config、utils/env.getKodeBaseDir → dataRoots、utils/state.getOriginalCwd →
> runtime/cwd、tooling/Tool → tool-interface),改指后零 core 依赖拆包成功;
> sandbox 完成 W4/W5(logging 换内部 console 辅助)成为叶子包;
> `utils/jsonlWriter`(276 行,node builtins only)下沉到 `@kode/runtime`
> (`#core/utils/jsonlWriter` alias 兼容全部引用方);
> tasks 薄壳依赖改指(env→dataRoots、state→runtime/cwd、legacyEnv→config);
> `services/notificationCenter`(90 行,零依赖内存通知中心)与
> `services/responseStateManager`(103 行,零依赖)下沉到 `@kode/runtime`;
> `services/statusline` 薄壳改指(`#runtime/cwd`)。
> `constants/{figures,macros,models,oauth,product}` 零依赖纯常量 → `@kode/constants`;
> `types/` 纯声明域 → `@kode/types`;`logging/` 子系统 → `@kode/logging`
> (内部薄壳全部改指:env→dataRoots、legacyEnv→config、planMode→@kode/plan、
> constants→@kode/constants、jsonlWriter→@kode/runtime、types→@kode/types)。
> `#core/utils/log` 与 `#core/utils/debugLogger` 转发壳经 alias 继续兼容 100+ 引用方。
> `mcp/` 客户端/服务端 → `@kode/mcp`(内部薄壳改指:state→runtime/cwd、
> notificationCenter→@kode/runtime、tooling/Tool→tool-interface、legacyEnv→config、
> log→@kode/logging、debugLogger→@kode/logging、env→dataRoots;残留 utils/config、
> messages、json、browser 与 tooling/splitTool 等厚依赖,待 utils 基础层拆分);
> `#host-mcp` alias 同步改指。
>
> 第三阶段:`utils/` 零依赖叶子下沉到 `@kode/runtime`(uuid、json、requestStatus、
> unaryLogging、sessionId);`message-utils/`(828 行,对 query 仅 type-only 依赖)
> → `@kode/message-utils`。core 规模 107,389 → 81,327 行(-24.3%)。
>
> 已知待办:
>
> - tasks 残留 2 类厚依赖(backgroundTasks→#core/query、file.normalizeFilePath),
>   需 query 基础层拆分后消除;logging 依赖已于本轮改指 @kode/logging
> - **ai 域双实现**:`packages/ai`(~8.8K)与 `core/src/ai`(~9.3K)重叠
>   (openai/retry.ts 完全相同、llm/openai/params.ts 几乎相同、adapters/chatCompletions
>   有漂移),两套均被生产引用(@kode/ai 17 处、#core/ai 大量);core→ai 反向依赖仅
>   测试(38 处),无生产级循环;合并需先确定权威版本并统一引用,建议专项处理
> - protocol 测试 `kodeAgentStreamJsonSession.test.ts:94,181` 的 2 个 tsc 错误为
>   仓库未提交 WIP 遗留(`abortController?: never` 与断言冲突),非本次改动引入;
>   runtime/taskOutputStore.ts 的 strict 空检查已防御性修复
>
> 待评估:`ai`(~9.2K)依赖 query/tooling/utils 等 core 基础层,`mcp`(~4.9K)依赖
> services/notificationCenter 等——均深度耦合,需先建立 utils/query/types 底层
> 包方可拆,列入下一阶段。

## 重复实现合并

| 日期       | 内容                            | 说明                                                                                                                                                       |
| ---------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-14 | `fileToolPermissionEngine` 去重 | core 的 rules/suggest/paths(≈600 行)与 `@kode/permissions` 内容一致,删除 core 副本,统一 re-export 自包;`plan.ts`(core 独有,依赖 core 内部)保留并改为包引用 |

## 调度系统专项优化

- `pollDueSchedule`(daemon 每秒热路径)补齐 6 个单元测试(claimed/unstarted/恢复/隔离)
- 删除 `ClaimDueSchedulesInput.limit`(文档称可多 claim,实现恒为 1)——单 tick 至多 claim 一个,语义显式化
- REPL 轮询统一到 `pollGoalSchedule`,消除与 daemon 的路径漂移

## 评估结论

- **双命令树不合并**:`apps/cli/src/commands/`(TUI slash 命令)与
  `apps/cli/src/entrypoints/cli/commands/`(CLI 子命令)职责不同,无重复实现。
- **别名不统一**:`#core/*` 2,167 处引用为项目设计选择(短别名),机械替换收益有限。
- **permissions 分层确认**:`@kode/permissions` = bash 语法引擎;`core/permissions` =
  权限策略层(依赖前者),非重复,保持。
