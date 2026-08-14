# 故障复盘：memory 事件日志无界增长且每轮全量重放

## 基本信息

| 字段          | 内容                                           |
| ------------- | ---------------------------------------------- |
| 日期          | 2026-08-14                                     |
| 发现人        | 性能审计                                       |
| 严重程度      | P2-一般（长期会话/长项目下持续恶化）           |
| 影响范围      | `packages/core/src/memory/` 持久化与检索热路径 |
| 关联 Issue/PR | 未关联                                         |
| 关联提交      | 当前工作区未提交                               |

## 1. 问题描述

### 1.1 问题场景

`getRelevantMemories` 与 `extractLongTermMemories` 位于 engine 每轮消息流水线
（`packages/engine/src/message-pipeline.ts:714-732`）的热路径上：每个带用户输入
的 turn 都会先 `extractLongTermMemories`（内部逐条 `rememberMemory`，最多 8 次），
再 `getRelevantMemories`（内部 `listMemories`）。

### 1.2 具体表现

1. **无界持久化**：`memories.jsonl` 只追加 `remember`/`forget` 事件，从不压缩。
   `forget` 也只是一条追加事件，磁盘上的日志随项目使用时间无限增长。
2. **热路径同步阻塞 I/O**：`listMemories`/`rememberMemory` 每次调用都执行
   `readFileSync` + 逐行 `JSON.parse` + 全量 `replayEvents`，且没有任何缓存。
   同目录的 `projectLearning/store.ts` 有 stat 键控缓存和 512KB 压缩阈值，memory
   存储两者皆无，行为不一致。

### 1.3 错误信息

无报错；问题表现为随事件数增长的每轮同步读盘与解析开销，以及磁盘文件持续膨胀。

## 2. 临时解决方案

无（性能问题，未引入临时开关）。

## 3. 根本原因分析

### 3.1 问题分析过程

1. 先审计渲染热路径（Message/PromptInput/REPL/requestStatus），这些区域已充分
   使用 `React.memo`/`useMemo`/`useCallback` 与增量缓存，未发现高置信问题。
2. 转向审计 `packages/core/src/memory/` 与 `projectLearning/` 时，发现两者同为
   追加式事件日志，但 projectLearning 有 `eventsCache`（stat 键控）与
   `compactEventLog`（512KB 阈值），memory 存储完全没有。
3. 确认 memory 存储被 engine 每轮消息流水线调用（`message-pipeline.ts:726`），
   属于真实热路径；而 `rememberMemory` 的指纹去重也依赖全量 `readEvents` 重放，
   每 turn 最多 8 次。
4. 定位结论：memory 事件日志既无缓存也无压缩，文件越大每轮重放越慢，且文件本身
   无上界。

### 3.2 直接原因

`packages/core/src/memory/store.ts` 的 `readEvents` 每次调用都
`readFileSync` + `JSON.parse` 全量事件；`appendEvent` 只追加不压缩。

**相关代码位置**：`packages/core/src/memory/store.ts`（修复前 `readEvents`、
`appendEvent`、`rememberMemory`、`forgetMemory`）

**关键代码片段**：

```ts
function readEvents(filePath: string): MemoryEvent[] {
  flushPendingSync(filePath)
  if (!existsSync(filePath)) return []
  try {
    return readFileSync(filePath, 'utf8') // 每次全量读盘 + 解析
      .split('\n')
      .flatMap(...)
  } catch { return [] }
}

function appendEvent(filePath: string, event: MemoryEvent): void {
  // 只追加；forget 也是一条追加事件，日志永不收缩
  appendJsonlAsync({ filePath, entry: `${JSON.stringify(event)}\n`, mode: 0o600 })
}
```

### 3.3 根本原因

- **设计层面**：追加式事件日志本身没有错，但必须配套"stat 键控缓存 + 阈值压缩"
  才能有界；memory 存储只实现了写入端，漏掉了读取端与压缩端。
- **开发层面**：memory 与 projectLearning 是同构存储，实现时未对齐 projectLearning
  已建立的缓存/压缩模式。
- **流程层面**：缺少"长期会话/长项目下存储是否仍满足热路径成本"的审查维度。

### 3.4 为什么没有提前发现

- 单测每个 `beforeEach` 用全新临时目录，事件数永远为 0~2，全量重放成本不可见。
- 没有对"重复调用同一未变更日志"与"大量事件后重放"做性能/规模断言。

## 4. 解决方案

### 4.1 根本解决方案

对齐 `projectLearning/store.ts` 的既有模式：

1. **stat 键控缓存**：`readEvents` 以 `size + mtimeMs` 为键缓存解析结果；文件未变
   时直接返回，避免每轮全量读盘 + 解析。
2. **事件日志压缩**：`EVENT_LOG_COMPACT_MAX_BYTES`（默认 512KB）超限时在锁内将
   日志重写为"每条当前记录一个 remember 事件"，丢弃 forget 事件，使重放成本与
   磁盘占用保持有界。
3. 写入后主动失效缓存条目，避免读到陈旧数据。

**修改文件**：`packages/core/src/memory/store.ts`、`packages/core/src/memory/index.ts`

**修改前**：

```ts
function readEvents(filePath: string): MemoryEvent[] {
  flushPendingSync(filePath)
  if (!existsSync(filePath)) return []
  try {
    return readFileSync(filePath, 'utf8').split('\n').flatMap(/* parse */)
  } catch {
    return []
  }
}
```

**修改后**（要点）：

```ts
type CachedEvents = { size: number; mtimeMs: number; events: MemoryEvent[] }
const eventsCache = new Map<string, CachedEvents>()

function readEvents(filePath: string): MemoryEvent[] {
  flushPendingSync(filePath)
  if (!existsSync(filePath)) return []
  try {
    const stats = statSync(filePath)
    const cached = eventsCache.get(filePath)
    if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) {
      return cached.events // 文件未变：零读盘、零解析
    }
    /* 读盘 + 解析并写入 eventsCache */
  } catch { return [] }
}

function appendEvent(filePath: string, event: MemoryEvent): void {
  appendJsonlAsync({ filePath, entry: `${JSON.stringify(event)}\n`, mode: 0o600 })
  eventsCache.delete(filePath) // 追加是异步的，先失效，下次读取前会 flush
}

function compactEventLog(filePath: string): void {
  const records = replayEvents(readEvents(filePath))
  atomicRewriteJsonl(filePath, records.map(record => /* 一个 remember 事件 */))
}
```

`rememberMemory` / `forgetMemory` 在 `appendEvent` 后检查
`jsonlSize(eventsPath) > EVENT_LOG_COMPACT_MAX_BYTES` 则压缩（在锁内执行）。

**方案说明**：缓存与压缩都是只读优化 + 重写优化，不改变对外 API 与记录语义
（压缩后 `replayEvents` 结果与压缩前一致）；压缩失败是 best-effort，不影响存储可用
性。与 projectLearning 完全同构，降低后续维护心智负担。

**回归测试**：`packages/core/src/memory/memory.test.ts` 新增
`compacts the append-only event log so replay stays bounded`：设置极小阈值后
remember → forget → remember，断言最终日志仅含一条 `remember` 事件、记录集不变。
另提供测试钩子 `__setMemoryCompactThresholdForTests`。

### 4.2 影响范围评估

- 同一进程内写入路径全部经过 `appendEvent`（已失效缓存）；跨进程外部写入会因
  `size/mtime` 变化自然失效缓存。
- 压缩在锁内执行，与既有 `acquireLock` 语义一致；`mtimeMs` 毫秒级粒度在
  projectLearning 中已被接受，memory 使用相同权衡。
- 磁盘占用从"无限增长"变为"约 512KB 有界"。

## 5. 预防措施

### 5.1 代码层面

- [x] 追加式事件日志必须配套 stat 键控缓存与字节阈值压缩（与 projectLearning 对齐）。
- [ ] 新增存储模块前检查同构模块是否已建立缓存/压缩模式，避免行为漂移。

### 5.2 测试层面

- [x] 增加事件日志压缩回归测试（含测试阈值钩子）。
- [x] 修正"no process-local cache"过时注释，改为 stat 键控缓存语义。
- [ ] 未来对热路径存储增加"大量事件下重放次数"的规模断言。

### 5.3 监控层面

- [ ] 可选的：对 memory/learning 事件日志字节数记录日志，超阈值告警。

### 5.4 流程/规范层面

- [ ] 性能审计清单补充：热路径上的同步文件 I/O 必须有缓存或节流，持久化必须有界。

## 6. 经验总结（一句话）

追加式事件日志若不同时提供 stat 键控读取缓存与阈值压缩，就会在热路径上随历史
无限放大读盘/重放成本并让磁盘无界增长——同构的 projectLearning 已有成熟模式，新
实现必须对齐。

---

## 附：同次审计的次要修复

`apps/cli/src/utils/completion/fileSuggestions.ts` 中 `matchAdvanced`（内部跑 7 个
匹配算法）对每个模糊命中的目录项被调用两次：一次在 `.filter()` 判 `matched`，一次
在 `.map()` 取 `score`。修复为单趟循环内计算一次并复用，行为不变（确定性算法）。
回归测试：`fileSuggestions.test.ts` 现有用例全部通过，并新增
`drops entries that neither prefix-match nor fuzzy-match in one pass`。
