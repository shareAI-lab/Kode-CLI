<div align="center">

# Kode

**终端中的 AI 编程伙伴**

<img width="880" alt="Kode Banner" src="https://github.com/user-attachments/assets/c1751e92-94dc-4e4a-9558-8cd2d058c1a1" />

[![npm version](https://img.shields.io/npm/v/@shareai-lab/kode?style=flat-square&color=CB3837&logo=npm)](https://www.npmjs.com/package/@shareai-lab/kode)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue?style=flat-square)](https://opensource.org/licenses/Apache-2.0)
[![AGENTS.md](https://img.shields.io/badge/AGENTS.md-Compatible-brightgreen?style=flat-square)](https://agents.md)
[![GitHub Stars](https://img.shields.io/github/stars/shareAI-lab/kode?style=flat-square&color=yellow)](https://github.com/shareAI-lab/kode)

[English](README.md) · [贡献指南](CONTRIBUTING.md) · [文档](docs/README.md) · [发布页](https://github.com/shareAI-lab/kode/releases)

---

**理解代码库 · 编辑文件 · 执行命令 · 编排工作流**

</div>

<br/>

<p align="center">
  <img width="90%" alt="Kode Demo" src="https://github.com/user-attachments/assets/fdce7017-8095-429d-b74e-07f43a6919e1" />
</p>

## 目录

- [核心亮点](#核心亮点)
- [安装](#安装)
- [快速开始](#快速开始)
- [多模型协同](#多模型协同)
- [Agents 与子代理](#agents-与子代理)
- [技能与插件](#技能与插件)
- [MCP 扩展](#mcp-扩展)
- [权限与安全](#权限与安全)
- [配置](#配置)
- [开发](#开发)
- [许可证](#许可证)

## 核心亮点

<table>
<tr>
<td width="50%">

### 智能编程

- **多模型编排** — 组合 20+ AI 模型，各司其职
- **专家咨询** — `@ask-model-name` 调用专家模型分析
- **任务委派** — `@run-agent-name` 编排子代理协作
- **智能补全** — 7+ 算法融合模糊匹配

</td>
<td width="50%">

### 开发体验

- **开箱即用** — 兼容任何 OpenAI 风格的 API 端点
- **AGENTS.md 标准** — 兼容 60k+ 开源项目指令格式
- **丰富的终端 UI** — 语法高亮、图片支持、行内编辑
- **高度可扩展** — 技能、插件、MCP 服务器、自定义代理

</td>
</tr>
</table>

> [!NOTE]
> **安全提示**：Kode 默认以 YOLO 模式运行以获得最高效率。处理重要文件时建议使用 `kode --safe` 启用权限审批。
>
> **模型建议**：请使用专为自主任务完成设计的 Agent 模型（而非 GPT-4o 等传统问答模型）以获得最佳体验。

## 安装

```bash
npm install -g @shareai-lab/kode
```

<details>
<summary><b>🇨🇳 国内镜像 / 更多选项</b></summary>

```bash
# 国内镜像
npm install -g @shareai-lab/kode --registry=https://registry.npmmirror.com

# 开发版（最新特性）
npm install -g @shareai-lab/kode@dev
```

Kode 通过 `optionalDependencies` 按平台提供 ripgrep 和原生二进制。若使用 `--no-optional` 安装，请自行安装系统 `rg` 或设置 `KODE_RIPGREP_PATH`。

</details>

<details>
<summary><b>单文件二进制（免安装）</b></summary>

从 [GitHub Releases](https://github.com/shareAI-lab/kode/releases) 下载对应平台的 Bun 编译产物。详见 `docs/binary-distribution.md`。

</details>

安装后可用以下任一命令：

| 命令 | 说明 |
|------|------|
| `kode` | 主命令 |
| `kwa` | Kode With Agent |
| `kd` | 超短别名 |

## 快速开始

### 交互模式

```bash
kode
```

### 单次模式

```bash
kode -p "解释这个函数" path/to/file.js
```

### ACP 模式（Agent Client Protocol）

```bash
kode-acp          # stdio JSON-RPC，供 Toad/Zed 等客户端接入
```

### 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Enter` | 发送消息 |
| `Option+Enter` | 输入框内换行 |
| `Option+M` | 切换活跃模型 |
| `Option+G` | 用 `$EDITOR` 编辑消息 |
| `Ctrl+V` | 粘贴剪贴板图片（macOS） |

### 斜杠命令

```
/model          更改 AI 模型设置
/config         打开配置面板
/agents         管理子代理
/plugin         管理技能与插件
/output-style   切换输出风格
/cost           查看 Token 用量与费用
/clear          清除对话历史
/help           显示所有命令
```

## 多模型协同

与单模型工具不同，Kode 支持**真正的多模型编排** — 为不同任务分配最合适的模型。

### 架构

```
┌─────────────────────────────────────────────────┐
│                  ModelManager                     │
├──────────┬──────────┬───────────┬───────────────┤
│   main   │   task   │  compact  │     quick     │
│  (主模型) │ (子代理) │  (压缩)   │   (轻量操作)  │
└──────────┴──────────┴───────────┴───────────────┘
         │                │                │
    主 Agent         SubAgents        专家咨询
```

**模型指针** — 通过 `/model` 为不同角色配置默认模型：

| 指针 | 用途 |
|------|------|
| `main` | 主对话模型 |
| `task` | 子代理 / 任务委派模型 |
| `compact` | 接近上下文窗口上限时的压缩模型 |
| `quick` | 快速操作与工具调用 |

### 可分享的配置（YAML）

```bash
kode models export --output kode-models.yaml   # 导出（不含明文密钥）
kode models import kode-models.yaml            # 导入（合并）
kode models import --replace kode-models.yaml  # 导入（替换）
kode models list                               # 列出配置
```

### 工作流示例

```bash
# 架构设计 — 使用推理模型
"用 o3 设计消息队列系统架构"

# 代码实现 — 使用编码模型
"用 Qwen Coder 作为子代理并行重构这三个模块"

# 专家咨询 — 请教专业模型
"问问 Claude Opus 4.1 这个内存泄漏怎么解决"

# 模型切换 — Option+M 或内联指定
"切换到 Kimi k2 进行代码审查"
```

### 核心能力对比

| 特性 | Kode | 单模型 CLI |
|------|------|-----------|
| 支持模型数 | 无限制 | 一个 |
| 实时切换 | `Option+M` | 需重启 |
| 并行子代理 | 支持 | 不支持 |
| 分模型成本追踪 | 支持 | 不支持 |
| 专家咨询 | `@ask-*` | 不支持 |

## Agents 与子代理

Agents 是可复用的任务委派模版。

```bash
# 管理
/agents                          # 交互式 UI
kode agents validate             # 校验模版

# 运行
@run-agent-reviewer ...          # @ 提及方式
Task(subagent_type: "reviewer")  # 工具调用方式
```

**Agent 文件**（`.kode/agents/reviewer.md`）：

```markdown
---
name: reviewer
description: "Review diffs for correctness, security, and simplicity"
tools: ["Read", "Grep"]
model: inherit
---

更严格一些：指出 bug / 风险点，优先推荐小而聚焦的修改。
```

加载来源：`.kode/agents`（项目）→ `~/.kode/agents`（用户）→ 插件 → `--agents` 参数。

`model` 字段支持：`inherit`、指针名（`main|task|compact|quick`）、profile 名称、`provider:modelName`。

## 技能与插件

### 从 Marketplace 安装

```bash
kode plugin marketplace add owner/repo
kode plugin install document-skills@anthropic-agent-skills --scope user
```

### 使用技能

作为斜杠命令运行（`/pdf`、`/xlsx`），或让 Kode 自动调用。

### 创建技能

创建 `.kode/skills/<name>/SKILL.md`：

```markdown
---
name: my-skill
description: 描述这个技能做什么、何时使用。
allowed-tools: Read Bash(git:*) Bash(jq:*)
---

# 技能说明
```

详见 `docs/skills.md`。

## MCP 扩展

通过 [Model Context Protocol](https://modelcontextprotocol.io) 接入外部工具服务器。

```bash
kode mcp add              # 添加服务器
kode mcp list             # 查看已连接服务器
kode mcp remove <name>    # 移除服务器
```

配置文件（项目根目录 `.mcp.json`）：

```json
{
  "my-server": { "type": "sse", "url": "http://127.0.0.1:3333/sse" }
}
```

## 权限与安全

| 模式 | 行为 |
|------|------|
| 默认（YOLO） | 跳过权限提示，追求效率 |
| `kode --safe` | 写入与命令需手动审批 |
| 计划模式 | 方案批准前仅允许只读操作 |

### 系统沙箱（Linux）

启用 `--safe` 或 `KODE_SYSTEM_SANDBOX=1` 后，Bash 命令在 `bwrap` 沙箱中运行（默认禁用网络）。

### 网络与隐私

- **默认不发送遥测数据**
- 仅在以下场景产生网络请求：模型 API 调用、Web 工具、插件下载、可选更新检查

## 配置

| 范围 | 位置 |
|------|------|
| 全局配置 | `~/.kode.json`（或 `$KODE_CONFIG_DIR/config.json`） |
| 项目设置 | `.kode/settings.json`、`.kode/settings.local.json` |
| MCP 服务器 | `.mcp.json` 或 `.mcprc` |
| Agents | `.kode/agents/*.md` |
| 技能 | `.kode/skills/*/SKILL.md` |

### AGENTS.md 支持

Kode 从仓库根目录到 CWD 逐层发现指令文件：

- 优先 `AGENTS.override.md` > `AGENTS.md`（每层最多一个）
- 按 root → leaf 拼接（上限 32 KiB，可通过 `KODE_PROJECT_DOC_MAX_BYTES` 覆盖）
- 兼容 legacy `CLAUDE.md` / `.claude/` 格式

## Docker

```bash
git clone https://github.com/shareAI-lab/Kode.git && cd Kode
docker build --no-cache -t kode .

# 在项目目录中运行
cd your-project
docker run -it --rm \
  -v $(pwd):/workspace \
  -v ~/.kode:/root/.kode \
  -v ~/.kode.json:/root/.kode.json \
  -w /workspace \
  kode
```

## 开发

开发环境需要 [Bun](https://bun.sh)。

```bash
# 初始化
git clone https://github.com/shareAI-lab/kode.git && cd kode
bun install

# 开发 / 构建 / 测试
bun run dev
bun run build
bun test
```

## 许可证

[Apache 2.0](LICENSE) — 自由用于个人、商业和企业项目。

## 致谢

- 部分代码源自 @dnakov 的 anonkode
- UI 灵感来自 gemini-cli
- 系统设计借鉴了上游 agent CLI 工具

---

<div align="center">

**[文档](docs/)** · **[报告问题](https://github.com/shareAI-lab/kode/issues)** · **[讨论](https://github.com/shareAI-lab/kode/discussions)**

<sub>Kode 将在 2026 年 7 月至 12 月进入大规模维护与重构阶段。<br/>请关注后续版本发布与公告，敬请期待。</sub>

</div>
