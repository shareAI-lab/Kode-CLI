# 故障复盘：默认权限模式改为 plan 后权限引擎测试未同步

## 基本信息

| 字段          | 内容                                                                 |
| ------------- | -------------------------------------------------------------------- |
| 日期          | 2026-08-14                                                           |
| 发现人        | 自动化测试（file-permission-engine / skill-slash-permission-parity） |
| 严重程度      | P2-一般（测试回归 + 文档不一致）                                     |
| 影响范围      | `createDefaultToolPermissionContext` 默认值、6 个权限测试            |
| 关联 Issue/PR | 未关联                                                               |
| 关联提交      | 当前工作区未提交                                                     |

## 1. 问题描述

### 1.1 问题场景

工作区把 `createDefaultToolPermissionContext` 的默认 `mode` 从 `'yolo'` 改为 `'plan'`，同时把 `permissionModeState` 的 `ACTUAL_DEFAULT_MODE` 改为 `'plan'`，并新增 plan 模式硬门槛（`engine.ts` 在 plan 模式拦截一切非只读工具）。

### 1.2 具体表现

6 个测试失败：写建议流、plan 文件写入、scratchpad 写入、以及 `Edit(~/**)`/`Write(~/**)`/`Skill(ns:*)` 允许规则匹配。这些测试原本依赖默认 mode 为可写模式。

### 1.3 错误信息

```
expect(result.result).toBe(true)  // 实际 false（被 plan 硬门槛拒绝）
expect(updates.length).toBeGreaterThan(0)  // 实际 0（plan 拒绝不产生建议）
```

## 2. 临时解决方案

未采用临时绕过。

## 3. 根本原因分析

### 3.1 问题分析过程

1. 安全加固把默认模式改为 plan（代码 + 注释 + `tool-permission-context.test.ts` 已同步更新）。
2. plan 硬门槛在规则引擎之前拦截所有非只读工具，因此写/编辑/技能类工具不再进入建议流与允许规则匹配。
3. `file-permission-engine.test.ts` 与 `skill-slash-permission-parity.test.ts` 的 6 个用例本意是测“规则引擎”，却隐式依赖默认 mode，未显式声明 mode。
4. README 仍写“默认（YOLO）”，与代码不一致。

### 3.2 直接原因

测试隐式依赖全局默认 mode，且文档未同步。

### 3.3 根本原因

- **设计层面**：`createDefaultToolPermissionContext` 没有暴露 mode 参数，测试无法显式指定。
- **开发层面**：改默认值后只更新了一个测试文件，未跑全量单测。
- **流程层面**：README 的“默认模式”文案未纳入权限默认值改动的 checklist。

### 3.4 为什么没有提前发现

- 单个测试文件在隔离运行下不会暴露默认值依赖（只在全量下才有对比）。
- README 的权限默认值描述属于静态文案，CI 不校验。

## 4. 解决方案

### 4.1 根本解决方案

给 `createDefaultToolPermissionContext` 增加可选 `mode` 参数（默认仍为 `plan`），让测规则引擎的用例显式传入 `mode: 'acceptEdits'`；`skill-slash-permission-parity` 的 `makeContext` 显式设置 `permissionMode: 'acceptEdits'`。plan 硬门槛与 `permission-mode-plan.test.ts` 保持不变。

**修改文件**：`packages/core/src/types/toolPermissionContext.ts`、`packages/core/src/test/unit/file-permission-engine.test.ts`、`packages/core/src/test/unit/skill-slash-permission-parity.test.ts`

### 4.2 影响范围评估

生产默认仍为 plan；测试改为显式声明被测模式，不再受全局默认值影响。

## 5. 预防措施

### 5.1 代码层面

- [x] 暴露 `mode` 参数，使调用方/测试可显式选择模式。

### 5.2 测试层面

- [x] 规则引擎测试显式声明 mode，与全局默认值解耦。

### 5.3 监控层面

- [ ] 后续将 README“默认（YOLO）”文案与实际默认值（plan）对齐，并纳入发布 checklist。

### 5.4 流程/规范层面

- [ ] 修改全局默认值时，必须跑全量单测并同步用户文档。

## 6. 经验总结（一句话）

测试不应隐式依赖全局默认值，全局默认值的改动必须触发全量测试与文档同步。
