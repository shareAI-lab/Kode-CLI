# 架构审查与优化方案（2026-08-14）

> 范围:全仓库三应用(apps/cli, apps/server, apps/web)+ 40 个 packages。
> 方法:依赖图扫描 + 循环检测 + 三个并行子代理深审(core / cli / server)。
> 状态:typecheck 全绿;仓库处于 Strangler Fig 拆包中途态(见 docs/architecture-refactor.md)。

## 0. 现状总览

| 模块            | 规模                            | 评估                                                      |
| --------------- | ------------------------------- | --------------------------------------------------------- |
| apps/cli        | 644 文件 / 96,456 行            | ui/ 占 63%,上帝组件集中                                   |
| apps/server     | 89 文件 / 527 KB                | 分层骨架健康,三入口各自为政                               |
| apps/web        | 61 文件 / 235 KB                | 小,边界清晰(@kode/client + @kode/protocol)                |
| packages/core   | 507 文件 / 91,703 行(生产 ~30K) | 拆包中途态:镜像+垫片+测试垃圾场+真实现                    |
| packages/tools  | 139 文件 / 610 KB               | 工具按域组织(ai/fs/interaction/mcp/network/search/system) |
| packages/engine | 32 文件 / 185 KB                | 执行管线薄编排,核心逻辑滞留在 core                        |
| 其余 34 包      | —                               | config(19 依赖者)为最底层;tool-interface(9)次之           |

**依赖图结论**:生产代码无硬循环(protocol↔config 仅测试文件成环);分层方向大体正确
(server→packages→core→基础包),但被 `#core/*` 伪命名空间抹平(见 P0-1)。

---

## 1. 三大核心问题(按影响排序)

### 🔴 P0-1 `#core/*` 伪命名空间抹平包边界(1,275 处引用,46 条 tsconfig 映射)

- **证据**:tsconfig.json 中 20+ 条 `#core/*` 被重映射到**其它包**(constants/logging/sandbox/
  tasks/runs/memory/plan/json/requestStatus/...);`packages/engine`、`packages/tools` 声明了
  `@kode/core` 依赖但生产代码 **0 直接引用**,实际全部走 `#core/*` 深路径(engine 39 处、
  tools 93 处、cli 445 处)。
- **影响**:依赖声明与真实依赖永远失真;移动文件到新包=改一行 tsconfig 的"零成本谎言";
  幽灵依赖(如 core 的 `utils/planMode.ts` 引用 @kode/plan 但 package.json 未声明)。
- **方案**:分批把映射到其它包的别名改为直接 `@kode/*` 导入并删别名;
  保留 `#core` 仅指向 core 自身;每批跑 package-boundaries.test.ts 校验。

### 🔴 P0-2 core/src/ai 与 @kode/ai 双份镜像,靠测试手工同步(28 个同名文件)

- **证据**:`packages/core/src/test/unit/openai-provider-mirror.test.ts` 强制两份内容等价;
  `package-boundaries.test.ts` 禁止 core 生产代码 import @kode/ai → 死锁:
  "禁引 + 自留镜像"。`openai/retry.ts` 逐字符相同,`adapters/chatCompletions.ts` 已漂移;
  core 侧另有 anthropic(976 行)/externalRuntime/codexOAuth 等 @kode/ai 没有的实现。
- **影响**:AI 层每次改动双改;镜像测试成为重构阻力;core 体积无法收敛。
- **方案**:解除"core 不依赖 @kode/ai"禁令 → core 生产代码改 import @kode/ai →
  删除 core/src/ai 镜像(或过渡为 re-export)→ 删 mirror 测试。core 独有实现
  (anthropic/externalRuntime)先并入 @kode/ai 再统一引用。

### 🔴 P0-3 同一"会话/权限"概念多处重复实现(server 三入口各自为政)

- **证据**:权限请求逻辑**三份**(handlers/chat.handler.ts:175-300、ws/connection.ts:247-330、
  acp/agent/permissions.ts),且 PermissionControlService 不服务任何 turn 内决策;
  会话存储**五套**(sessionRegistry 内存 / sessionMetadataStore / persistentSessionService /
  acp/sessionStore + 死代码 acp/agent/sessionStore.ts);ACP 会话与 daemon 会话互不可见。
- **影响**:权限语义三处演进=安全漏洞温床;同一用户 ACP 建的会话 resume 不了 daemon 的。
- **方案**:提取 `createToolPermissionGate` 单一实现三处共用;删死代码;
  中期 ACP 会话落盘到 daemon 会话体系,PersistentSessionService 统一管理。

---

## 2. apps/cli 专项问题

### 2.1 三套命令表面 + 插件域碎片化

- `src/commands/`(斜杠 /xxx)、`entrypoints/cli/commands/`、`entrypoints/cli/cliParser/commands/`
  三套并存;**同名双实现**:config/doctor/import/skills/status;
  plugin 一个域有 3 个表面(/plugin、/plugins、kode plugin);
  goal(457 行)/voice(364 行)内嵌服务逻辑。
- **方案**:建立单一 CommandSpec 元数据(name/aliases/surface/handler),commander 与斜杠
  注册都从它生成;斜杠命令收敛为薄适配器;插件三处整合为一个包。

### 2.2 入口层多份真相

- dispatch.ts 裸扫 argv(--version/--ripgrep/--mcp-cli);app.tsx:32-77 再裸扫
  (wantsPrintMode/isDaemonLifecycleCommand);program.tsx 的 commander 才是权威。
  另:entrypoints/cli.ts(8 行)是冗余间接层;rootAction.ts 591 行巨函数。
- **方案**:单一 resolver 输出 RuntimeMode;app.tsx 只做环境引导;删 cli.ts 间接层。

### 2.3 上帝组件/Hook(14 个 >600 行)

- McpServersScreen 2,236 / ResumeSessionSelector 1,831 / **useReplController 1,788**(REPL
  状态中枢:cost+log+apiKey+cancel+voice+GoalService+消息 store)/ PromptInput 1,340 /
  KeypressContext 1,106(裸键解析+粘贴保护+ESC 超时+Mac Alt+鼠标+batchedUpdates)/
  PluginsScreen 1,209。
- **方案**:useReplController 按关注点拆 hooks 再组合;KeypressContext 拆"键序解析(纯函数,
  可单测)+分发"两层;ui/ 上 max-lines 500 lint 门槛。

### 2.4 services/ 无契约,通用能力滞留 CLI

- daemon 生命周期(daemonRegistry 382 + daemonSupervisor 264 + nodeDaemonProcessController
  444 行)packages 中 0 引用 → 应下沉 packages/runtime 或新 packages/daemon;
  外部厂商认证(codexLogin 434 / copilotLogin 123 / externalRuntime 125)应下沉 packages/ai;
  插件逻辑横跨 4 个 services 目录。
- **方案**:一页 ADR 定义 services 边界(只允许 CLI 专属编排);按域下沉。

---

## 3. apps/server 专项问题

### 3.1 ws/connection.ts(1,092 行)上帝对象

- 13 种消息 + fs_read/fs_write + 5 种 git 操作 + 第二份 requestToolPermission 全在一个
  `message()` 函数;WebUI 的 git 能力只存在于 WS,无法被 REST 复用。
- **方案**:按 parseClientWsMessage 判别式拆 ws/handlers/{prompt,git,files,session};
  fs/git 提升为 WorkspaceFileService/GitService。

### 3.2 core 进程级全局状态迫使 daemon turn 全局互斥

- setCwd/setOriginalCwd(chat.handler:118、connection:443、acp/sessions:78)共享
  @kode/core/utils/state 进程级全局;turnGate.ts:70-77 注释自证;routes/index.ts:257
  "Daemon runtime is busy"。
- **影响**:单进程只能跑一个活动 turn;daemon 与 CLI 不能同进程;多 workspace 并发
  被架构性禁止。**根治需 core 的 ExecutionContext 改造,跨包影响大,独立排期。**

### 3.3 其余

- routes/index.ts 顺序匹配 + 各路由自 split('/') 解析 → 引入路由表/Bun.serve routes。
- chat.handler.ts 492 行上帝函数(权限+记录+持久化+超时+中断+成本)。
- 亮点:server.ts 组合根清晰;三个控制服务 DI+审计合格;四个入口复用 @kode/engine runTurn。

---

## 4. packages/core 专项问题

### 4.1 拆包中途态(核心矛盾)

core 同时是:**镜像库**(ai 52 文件)、**垫片库**(utils/ 20 个纯 re-export,如
planMode→@kode/plan、log→@kode/logging、config→@kode/config、secureFile→security/)、
**测试垃圾场**(test/ 287 文件占 57%,34 个直接 import 外部包:engine 15/agent 8/hooks 9)、
**真实现**(permissions/message-utils/tooling/query)。

### 4.2 engine 是 core 的薄壳(职责倒置)

- engine/src/messages/ 6 个文件与 core/src/message-utils/ 同名,normalize.ts 逐行 re-export;
  engine 的 queryLLM/cost-tracker/systemPrompt/workspaceSafety/maxBudgetUsd 全部在 core。
- **方案**:engine 需要的执行逻辑(ai 调用、cost、systemPrompt、errors)移入 engine 或
  @kode/ai;message-utils 归 engine 或独立 messages 包。

### 4.3 core 公共 API 面为零

- index.ts 仅导出 4 项(permissions + tooling),其余 210 个生产文件全走深路径
  `#core/*` → 无公共契约,任何内部移动都是破坏性变更。
- **方案**:为保留在 core 的模块建 barrel 导出,消费方收敛到 `@kode/core/*`。

---

## 5. 优化路线图(建议执行顺序)

### 阶段 A:低风险收敛(1-2 天,可独立合入)

1. 删死代码:acp/agent/sessionStore.ts(全仓 0 引用)。
2. 删 core 死代码:utils/autoUpdater.ts、utils/startupProfile.ts、constants/releaseNotes.ts(0 引用)。
3. core/test 按 import 目标批量迁移(engine 15 → packages/engine,agent 8 → packages/agent,
   hooks 9 → packages/hooks,其余按文件名域);core 保留真正测自身的 ~160 个。
4. AGENTS.md 恢复为正常内容(git show e26d8d93~1:AGENTS.md 有历史版本)。

### 阶段 B:解 ai 双镜像死锁(2-3 天,收益最大)

1. 放宽 package-boundaries.test.ts 的 ai 禁令;
2. core/src/ai 独有实现(anthropic/externalRuntime/codexOAuth/grokBuild/githubCopilot)
   并入 @kode/ai;
3. core 生产代码改 import @kode/ai → 删 core/src/ai 52 文件 + mirror 测试;
4. 改 engine/cli/tools 的 `#core/ai/*` 消费方 → `@kode/ai/*`。

### 阶段 C:拆 #core 伪命名空间(2-3 天/批,4-6 批)

1. 映射到其它包的别名(46 条中约 30 条)→ 直接 @kode/* 并删别名;
2. 每批跑 typecheck + package-boundaries.test.ts;
3. 最终 `#core` 只指向 core 自身,依赖声明恢复真实。

### 阶段 D:server 权限/会话收敛(2-3 天)

1. createToolPermissionGate 单一实现替换 chat.handler/connection 两份副本;
2. ACP 会话落盘到 daemon 会话体系(短期先删死代码+统一目录)。

### 阶段 E:cli 命令表面统一(3-5 天)

1. CommandSpec 元数据 + 双注册生成器;
2. 合并 /plugin、/plugins、kode plugin;
3. 统一 config/goal/voice/agents 双实现,业务逻辑下沉 services。

### 阶段 F:上帝文件拆分(长期,持续)

1. useReplController(1,788)按关注点拆 hooks;
2. KeypressContext(1,106)拆键序解析纯函数;
3. McpServersScreen(2,236)/PluginsScreen(1,209)按区块拆组件;
4. ui/ 上 max-lines 500 lint。

### 明确不做(或独立排期)

- turnGate 全局互斥根治(依赖 core ExecutionContext 改造,跨包影响大)。
- 双命令树合并(斜杠命令与 CLI 子命令职责不同,评估确认不合并)。
- `#core/*` 别名全量机械替换为相对路径(2,167 处,收益有限)。

---

## 6. 关键证据文件索引

| 结论             | 证据                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| #core 伪命名空间 | tsconfig.json paths 段、packages/engine/src/message-pipeline.ts                                     |
| ai 双镜像        | packages/core/src/test/unit/{openai-provider-mirror,package-boundaries}.test.ts                     |
| 测试错位         | packages/core/src/test/unit/{maxBudgetUsdExceeded,agent-loader-lru-cache}.test.ts                   |
| 权限三份         | apps/server/src/{handlers/chat.handler.ts, ws/connection.ts, acp/agent/permissions.ts}              |
| 会话五套         | apps/server/src/{sessionRegistry,sessionMetadataStore,persistentSessionService,acp/sessionStore}.ts |
| 上帝组件         | apps/cli/src/ui/screens/REPL/useReplController.tsx 等 14 个                                         |
| 命令三表面       | apps/cli/src/commands/registry.ts、entrypoints/cli/cliParser/program.tsx                            |
| 幽灵依赖         | packages/core/src/utils/planMode.ts + core/package.json                                             |
| 跨 app 引用      | apps/cli/src/entrypoints/cli/cliParser/rootAction/webDaemon.ts → #daemon/server                     |
