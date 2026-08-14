# 故障复盘：Fetch 被错误映射为 WebSearch 展示器

## 基本信息

| 字段          | 内容                                         |
| ------------- | -------------------------------------------- |
| 日期          | 2026-08-14                                   |
| 发现人        | 代码审计                                     |
| 严重程度      | P2-一般                                      |
| 影响范围      | TUI 中名为 `Fetch` 或 `fetch` 的工具结果展示 |
| 关联 Issue/PR | 未关联                                       |
| 关联提交      | 当前工作区未提交                             |

## 1. 问题描述

### 1.1 问题场景

Fetch 工具返回网页正文或字符串结果，而 TUI 选择了 WebSearch 的结果展示器。

### 1.2 具体表现

非搜索结构的输出会渲染为 `✓ Search · 0 results`，实际抓取内容被隐藏。

### 1.3 错误信息

无运行时异常；错误是错误的 UI 语义与内容丢失。

## 2. 临时解决方案

未添加猜测 Fetch 结构的专用展示器。

## 3. 根本原因分析

### 3.1 问题分析过程

1. Presenter registry 为 `Fetch`、`fetch` 和 `WebSearch` 复用了同一 renderer。
2. Search renderer 只读取 `query`、`results` 和 `providers`。
3. 网页正文或普通字符串不具备该结构，命中数自然为 0。
4. `renderInkToolResultMessage` 的通用回退本可调用工具自身 renderer，但被 registry 映射抢先覆盖。

### 3.2 直接原因

Fetch 名称被注册到了不兼容的 WebSearch presenter。

**相关代码位置**：`apps/cli/src/ui/toolPresenters/registry.tsx:86-94`

### 3.3 根本原因

- **设计层面**：按工具名称共享 presenter 时没有验证输出契约。
- **开发层面**：把“网络工具”错误归为“搜索结果”。
- **流程层面**：缺少用非搜索正文验证 registry 分派的渲染测试。

### 3.4 为什么没有提前发现

- WebSearch 的正常结构测试无法暴露 Fetch 内容。
- UI 审查只验证摘要样式，没有验证回退渲染的数据保真。

## 4. 解决方案

### 4.1 根本解决方案

移除 `Fetch` 和 `fetch` 的错误映射，让它们落入工具自身或通用结果渲染；WebSearch 映射保持不变。

**修改文件**：`apps/cli/src/ui/toolPresenters/registry.tsx`、`apps/cli/src/ui/toolPresenters/WebSearchToolPresenter.test.tsx:23-39`

### 4.2 影响范围评估

搜索工具仍使用紧凑搜索摘要；Fetch 正文不再被伪装为零搜索结果。

## 5. 预防措施

### 5.1 代码层面

- [x] 删除不兼容名称映射，使用原有回退路径。
- [ ] 未来共享 presenter 前声明并检查输出类型。

### 5.2 测试层面

- [x] 增加 Fetch 字符串结果保留正文、且不含 Search 摘要的测试。

### 5.3 监控层面

- [ ] 暂不需要运行时监控；UI 回归由组件测试覆盖。

### 5.4 流程/规范层面

- [ ] TUI presenter 评审需验证输入结构、摘要和通用回退三种路径。

## 6. 经验总结（一句话）

展示器复用必须以输出契约相同为前提，名称相似不能替代数据结构验证。
