# 故障复盘：core 通过 openai shim 重新依赖 @kode/ai 破坏包边界

## 基本信息

| 字段          | 内容                                                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| 日期          | 2026-08-14                                                                                                           |
| 发现人        | 代码审计 + 自动化测试（package-boundaries.test.ts）                                                                  |
| 严重程度      | P1-严重                                                                                                              |
| 影响范围      | `@kode/core` 的架构边界、`@kode/ai` 依赖图                                                                           |
| 关联 Issue/PR | 未关联                                                                                                               |
| 关联提交      | `059064e2 fix(core): harden task persistence and coordination` 回退了 `840cd012 refactor: remove core ai dependency` |

## 1. 问题描述

### 1.1 问题场景

`packages/core/src/ai/openai/retry.ts` 与 `customModels.ts` 被改写成 `export * from '@kode/ai/openai/...'` 的兼容 shim，重新引入 `@kode/core → @kode/ai` 的依赖边。

### 1.2 具体表现

`package-boundaries.test.ts` 的 `keeps production core independent from @kode/ai` 失败，报出两个违规文件：

```
packages/core/src/ai/openai/customModels.ts -> @kode/ai/openai/customModels
packages/core/src/ai/openai/retry.ts -> @kode/ai/openai/retry
```

### 1.3 错误信息

无运行时异常；错误是架构边界被静默破坏。

## 2. 临时解决方案

未采用临时绕过。

## 3. 根本原因分析

### 3.1 问题分析过程

1. 提交 `840cd012` 明确移除了 `@kode/core` 对 `@kode/ai` 的依赖（删除 package.json 依赖项），并用 `package-boundaries.test.ts` 固化该边界。
2. 提交 `059064e2` 在任务/目标相关改动中，把 `retry.ts` 与 `customModels.ts` 从完整实现改写为对 `@kode/ai` 的 re-export shim，同时把 `@kode/ai` 加回 core 的 `package.json`。
3. 同一提交还修改 `openai-provider-mirror.test.ts`，新增 `AI_CANONICAL_PROVIDER_LEAF_FILES = ['customModels.ts', 'retry.ts']`，断言这两个文件必须是 shim。
4. 于是 `package-boundaries.test.ts`（core 不得 import @kode/ai）与 `openai-provider-mirror.test.ts`（这两个文件必须是 shim）变成互斥，测试无法同时通过。

### 3.2 直接原因

shim re-export 让 core 直接 import `@kode/ai`，违反已固化的边界。

### 3.3 根本原因

- **设计层面**：把“提供者传输归 @kode/ai”与“core 保持自洽”两个方向混在一个提交里，未在改动前验证边界测试。
- **开发层面**：`059064e2` 的提交信息是 task persistence 相关，却夹带了 openai shim 与依赖回退，属于越界改动。
- **流程层面**：边界测试与镜像测试各自独立演化，没有交叉校验一致性。

### 3.4 为什么没有提前发现

- shim 语义（`export *`）在类型检查下无报错。
- 镜像测试被“顺手”改成了兼容 shim 的断言，掩盖了矛盾。

## 4. 解决方案

### 4.1 根本解决方案

恢复 core 中两个文件为自洽实现（与 `@kode/ai` 同名文件逐字节一致），从 `@kode/core/package.json` 与 `bun.lock` 移除 `@kode/ai` 依赖，并移除镜像测试里的 `AI_CANONICAL_PROVIDER_LEAF_FILES` 特判，让两个测试都按“镜像副本 + core 独立”校验。

**修改文件**：`packages/core/src/ai/openai/retry.ts`、`packages/core/src/ai/openai/customModels.ts`、`packages/core/package.json`、`bun.lock`、`packages/core/src/test/unit/openai-provider-mirror.test.ts`

### 4.2 影响范围评估

core 重新自洽；`@kode/ai` 仍是独立的 host-agnostic 传输包，仅被 apps 层引用。

## 5. 预防措施

### 5.1 代码层面

- [x] 恢复镜像副本，删除 shim re-export。
- [x] 移除 core 对 @kode/ai 的依赖声明。

### 5.2 测试层面

- [x] 删除镜像测试中的 shim 特判，恢复逐字节等价断言。

### 5.3 监控层面

- [x] `package-boundaries.test.ts` 与 `openai-provider-mirror.test.ts` 同时通过，互为交叉校验。

### 5.4 流程/规范层面

- [ ] 提交与任务无关的架构改动时，拆分提交并单独跑边界/镜像测试。

## 6. 经验总结（一句话）

架构边界的“兼容 shim”会静默复活依赖边，镜像测试与边界测试必须互为约束、同时通过。
