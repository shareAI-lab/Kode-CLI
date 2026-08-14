<div align="center">

# Kode

**Your AI-Powered Terminal Coding Companion**

<img width="880" alt="Kode Banner" src="https://github.com/user-attachments/assets/c1751e92-94dc-4e4a-9558-8cd2d058c1a1" />

[![npm version](https://img.shields.io/npm/v/@shareai-lab/kode?style=flat-square&color=CB3837&logo=npm)](https://www.npmjs.com/package/@shareai-lab/kode)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue?style=flat-square)](https://opensource.org/licenses/Apache-2.0)
[![AGENTS.md](https://img.shields.io/badge/AGENTS.md-Compatible-brightgreen?style=flat-square)](https://agents.md)
[![GitHub Stars](https://img.shields.io/github/stars/shareAI-lab/kode?style=flat-square&color=yellow)](https://github.com/shareAI-lab/kode)

[中文文档](README.zh-CN.md) · [Contributing](CONTRIBUTING.md) · [Documentation](docs/README.md) · [Releases](https://github.com/shareAI-lab/kode/releases)

---

**Understand your codebase · Edit files · Execute commands · Orchestrate workflows**

</div>

<br/>

<p align="center">
  <img width="90%" alt="Kode Demo" src="https://github.com/user-attachments/assets/fdce7017-8095-429d-b74e-07f43a6919e1" />
</p>

## Table of Contents

- [Highlights](#highlights)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Interactive Help & Commands](#interactive-help--commands)
- [Voice Conversation (macOS)](#voice-conversation-macos)
- [Multi-Model Collaboration](#multi-model-collaboration)
- [Agents & Subagents](#agents--subagents)
- [Skills & Plugins](#skills--plugins)
- [MCP Extensions](#mcp-extensions)
- [Permissions & Security](#permissions--security)
- [Configuration](#configuration)
- [Development](#development)
- [License](#license)

## Highlights

<table>
<tr>
<td width="50%">

### Intelligent Coding

- **Multi-Model Orchestration** — Combine 20+ AI models, each excelling at different tasks
- **Expert Consultation** — `@ask-model-name` for specialized analysis
- **Agent Delegation** — `@run-agent-name` for task orchestration
- **Smart Completions** — Fuzzy matching with 7+ algorithms

</td>
<td width="50%">

### Developer Experience

- **Zero-Config Start** — Works out of the box with any OpenAI-compatible endpoint
- **AGENTS.md Standard** — Compatible with 60k+ open-source projects
- **Rich Terminal UI** — Syntax highlighting, image support, inline editing
- **Extensible** — Skills, plugins, MCP servers, custom agents

</td>
</tr>
</table>

> [!NOTE]
> **Security**: Kode runs in YOLO mode by default for maximum productivity. Use `kode --safe` to enable permission checks when working with critical files.
>
> **Model Advice**: Use agentic models designed for autonomous task completion (not Q&A-focused models like GPT-4o) for best results.

## Installation

```bash
npm install -g @shareai-lab/kode
```

<details>
<summary><b>🇨🇳 China Mirror / Additional Options</b></summary>

```bash
# China mirror
npm install -g @shareai-lab/kode --registry=https://registry.npmmirror.com

# Dev channel (latest features)
npm install -g @shareai-lab/kode@dev
```

Kode bundles per-platform `ripgrep` and native binaries via `optionalDependencies`. If installed with `--no-optional`, install system `rg` or set `KODE_RIPGREP_PATH`.

</details>

<details>
<summary><b>Standalone Binary (no npm)</b></summary>

Download Bun-compiled binaries from [GitHub Releases](https://github.com/shareAI-lab/kode/releases).

</details>

After installation, use any of these commands:

| Command | Description       |
| ------- | ----------------- |
| `kode`  | Primary command   |
| `kwa`   | Kode With Agent   |
| `kd`    | Ultra-short alias |

## Quick Start

### Interactive Mode

```bash
kode
```

On first use, run `/login` in the TUI to configure Codex, GitHub Copilot,
OpenAI, or another supported provider.

### One-Shot Mode

```bash
kode -p "explain this function" path/to/file.js
kode --headless --output-format json "list the public API in this package"
```

### ACP Mode (Agent Client Protocol)

```bash
kode-acp          # stdio JSON-RPC for Toad/Zed clients
```

### Get Help

```bash
kode --help        # CLI commands and non-interactive options
```

Inside the TUI, use `/help` for the current interactive guide. It reflects the
commands available in that installation; use the F7 command palette to search
the complete built-in, custom, plugin, and MCP command set.

### Keyboard Shortcuts

| Shortcut                 | Action                                 |
| ------------------------ | -------------------------------------- |
| `?` (empty input) / `F1` | Show shortcuts / open interactive help |
| `F2`                     | Open configuration                     |
| `F7`                     | Search the command palette             |
| `F8` / `Ctrl+T`          | Open background tasks / work tasks     |
| `Enter`                  | Submit message                         |
| `Option+Enter`           | Insert newline                         |
| `Option+M`               | Cycle active model                     |
| `Option+G` / `Ctrl+G`    | Open message in `$EDITOR`              |
| `Ctrl+V`                 | Attach clipboard image (macOS)         |
| `Ctrl+R`                 | Search prompt history                  |
| `Ctrl+O`                 | Toggle verbose transcript              |

## Interactive Help & Commands

`/help` is the authoritative guide for the running TUI. The list below is a
stable starting point rather than a static copy of every extension command.

| Command                                               | Use it for                                                                   |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| `/help`                                               | Keyboard shortcuts, common commands, and custom-command locations            |
| `/login`                                              | Configure Codex, GitHub Copilot, OpenAI, or another provider                 |
| `/model`, `/effort`                                   | Choose the session model and set a supported reasoning level                 |
| `/settings`, `/config`                                | Configure Kode, appearance, terminal behavior, and safeguards                |
| `/plan`, `/work`, `/review`                           | Plan, monitor, and review local work                                         |
| `/tasks`, `/goal`                                     | Inspect background work and manage durable goals                             |
| `/session`, `/clear`, `/resume`, `/rewind`            | Manage a conversation, checkpoints, and recovery                             |
| `/extensions`                                         | Manage plugins, skills, MCP servers, hooks, and agent configuration          |
| `/inspect`, `/status`, `/doctor`, `/cost`, `/console` | Inspect the session, workspace, installation, costs, and captured TUI output |
| `/voice`                                              | Record, review, and send a voice prompt on macOS                             |

The command palette and `/help` also show project/user custom commands and
commands contributed by enabled plugins or MCP servers. Their availability can
therefore vary by workspace and configuration.

## Voice Conversation (macOS)

Kode includes a macOS voice input/output surface backed by MiMo ASR and TTS.
Recordings are transcribed, shown for review, and only then submitted as a
normal message, so normal tool permissions still apply.

```bash
export MIMO_API_KEY="<your-mimo-api-key>"
kode
```

Then run `/voice` in the TUI. `/voice config` provides a keyboard-driven
settings screen and can store a pasted key in Kode's owner-only credential
store; environment credentials take precedence. Keys are never accepted as
slash-command arguments or written to `~/.kode.json`.

```text
/voice status                       Show redacted configuration and credential status
/voice config set language zh       Prefer Chinese recognition (auto, zh, or en)
/voice config set speak-responses false
/voice stop                         Stop the current spoken reply
```

Voice is enabled by default in the current CLI. To launch without it, use
`KODE_EXPERIMENTAL_VOICE=0 kode`. If capture reports that no microphone signal
was received, allow microphone access for the terminal and verify the selected
macOS input device before retrying.

## Multi-Model Collaboration

Unlike single-model tools, Kode enables **true multi-model orchestration** — assign the right model to the right task.

### Architecture

```
┌─────────────────────────────────────────────────┐
│                  ModelManager                     │
├──────────┬──────────┬───────────┬───────────────┤
│   main   │   task   │  compact  │     quick     │
│ (primary)│(subagent)│(summarize)│  (utilities)  │
└──────────┴──────────┴───────────┴───────────────┘
         │                │                │
    Main Agent      SubAgents       Expert Consult
```

**Model Pointers** — Configure defaults for each role via `/model`:

| Pointer   | Purpose                               |
| --------- | ------------------------------------- |
| `main`    | Primary conversation model            |
| `task`    | SubAgent / delegation model           |
| `compact` | Context compression near window limit |
| `quick`   | Fast operations & utilities           |

### Sign In, Reasoning, and Provider Compatibility

Use `/login` to add or switch a provider, `/model` to select the active model,
and `/effort [level]` to inspect or set the reasoning level supported by that
model. Kode validates the level against the active profile instead of applying
one setting to every provider. Provider-specific request shaping is automatic;
for example, MiMo profiles avoid OpenAI-only `reasoning_effort` parameters and
use their compatible thinking controls.

### Shareable Config (YAML)

```bash
kode models export --output kode-models.yaml   # Export (no plaintext keys)
kode models import kode-models.yaml            # Import (merge)
kode models import --replace kode-models.yaml  # Import (replace)
kode models list                               # List profiles + pointers
```

### Workflow Examples

```bash
# Architecture — use reasoning models
"Use o3 to design the message queue architecture"

# Implementation — use coding models
"Use Qwen Coder as subagent to refactor these three modules in parallel"

# Expert consultation — consult a specialist
"Ask Claude Opus 4.1 about this memory leak"

# Model switching — Option+M or specify inline
"Switch to Kimi k2 for code review"
```

### Key Capabilities

| Feature                 | Kode       | Single-Model CLI |
| ----------------------- | ---------- | ---------------- |
| Models Supported        | Unlimited  | One              |
| Live Switching          | `Option+M` | Restart required |
| Parallel SubAgents      | Yes        | No               |
| Per-Model Cost Tracking | Yes        | No               |
| Expert Consultation     | `@ask-*`   | Not available    |

## Agents & Subagents

Agents are reusable templates for task delegation and orchestration.

```bash
# Manage
/agents                          # Interactive UI
kode agents validate             # Validate templates

# Run
@run-agent-reviewer ...          # Via @ mention
Task(subagent_type: "reviewer")  # Via tool call
```

**Agent file** (`.kode/agents/reviewer.md`):

```markdown
---
name: reviewer
description: 'Review diffs for correctness, security, and simplicity'
tools: ['Read', 'Grep']
model: inherit
maxExecutionTimeMs: 300000
---

Be strict. Point out bugs and risky changes. Prefer small, targeted fixes.
```

Sources: `.kode/agents` (project) → `~/.kode/agents` (user) → plugins → `--agents` flag.

Model field accepts: `inherit`, pointer names (`main|task|compact|quick`), profile names, or `provider:modelName`.

`maxExecutionTimeMs` sets an active wall-clock deadline for the Agent (1,000–3,600,000 ms; default 300,000). Kode aborts overdue foreground and background runs, records their terminal state, and releases their concurrency slot. Use `/tasks` to inspect or stop live work and `/runs status` for durable run history.

Use `/work` as the work-control hub for the task board, plan mode, durable
goals, scheduled prompts, background tasks, durable runs, worktrees, and
read-only GitHub workflow/PR probes. These controls expose and manage work;
they do not bypass normal permission checks.

## Skills & Plugins

### Install from Marketplace

```bash
kode plugin marketplace add owner/repo
kode plugin install document-skills@anthropic-agent-skills --scope user
```

### Use Skills

Run as slash commands (`/pdf`, `/xlsx`) or let Kode invoke them automatically.

### Create a Skill

Create `.kode/skills/<name>/SKILL.md`:

```markdown
---
name: my-skill
description: Describe what this skill does and when to use it.
allowed-tools: Read Bash(git:*) Bash(jq:*)
---

# Skill instructions here
```

Use `/skills` or `/extensions` in the TUI to inspect the skills currently
available to this installation.

## MCP Extensions

Connect to [Model Context Protocol](https://modelcontextprotocol.io) servers to extend Kode's capabilities.

```bash
kode mcp add              # Add server
kode mcp list             # List connected servers
kode mcp remove <name>    # Remove server
```

MCP sampling remains separately opt-in because it can consume the configured
model quota: start Kode with `KODE_EXPERIMENTAL_MCP_SAMPLING=1` only when you
want a connected MCP server to request a model completion.

Config file (`.mcp.json` in project root):

```json
{
  "my-server": { "type": "sse", "url": "http://127.0.0.1:3333/sse" }
}
```

## Permissions & Security

| Mode           | Behavior                                |
| -------------- | --------------------------------------- |
| Default (YOLO) | Skips permission prompts for speed      |
| `kode --safe`  | Requires approval for writes & commands |
| Plan Mode      | Read-only until plan is approved        |

### System Sandbox (Linux)

With `--safe` or `KODE_SYSTEM_SANDBOX=1`, Bash commands run inside a `bwrap` sandbox (network disabled by default).

### Network & Privacy

- **No telemetry** by default
- Network requests only for: model API calls, web tools, plugin downloads, optional update checks

## Configuration

| Scope            | Location                                           |
| ---------------- | -------------------------------------------------- |
| Global config    | `~/.kode.json` (or `$KODE_CONFIG_DIR/config.json`) |
| Project settings | `.kode/settings.json`, `.kode/settings.local.json` |
| MCP servers      | `.mcp.json` or `.mcprc`                            |
| Agents           | `.kode/agents/*.md`                                |
| Skills           | `.kode/skills/*/SKILL.md`                          |

Use `/settings` for the configuration hub, `/config` for direct configuration,
and `/model` for provider/model selection. `kode models export` and
`kode models import` move shareable model profiles without plaintext keys.

### AGENTS.md Support

Kode discovers instruction files from repo root to CWD:

- Prefers `AGENTS.override.md` > `AGENTS.md` (one per directory)
- Concatenated root → leaf (32 KiB cap, override with `KODE_PROJECT_DOC_MAX_BYTES`)
- Legacy `CLAUDE.md` / `.claude/` compatibility included

## Docker

```bash
git clone https://github.com/shareAI-lab/Kode.git && cd Kode
docker build --no-cache -t kode .

# Run in your project
cd your-project
docker run -it --rm \
  -v $(pwd):/workspace \
  -v ~/.kode:/root/.kode \
  -v ~/.kode.json:/root/.kode.json \
  -w /workspace \
  kode
```

## Development

Requires [Bun](https://bun.sh) for development.

```bash
# Setup
git clone https://github.com/shareAI-lab/kode.git && cd kode
bun install

# Dev / Build / Test
bun run dev
bun run build
bun run typecheck
bun test
```

## License

[Apache 2.0](LICENSE) — Use freely in personal, commercial, and enterprise projects.

## Acknowledgements

- Some code from @dnakov's anonkode
- UI inspiration from gemini-cli
- System design learned from upstream agent CLIs

---

<div align="center">

**[Documentation](docs/)** · **[Report Issues](https://github.com/shareAI-lab/kode/issues)** · **[Discussions](https://github.com/shareAI-lab/kode/discussions)**

<sub>From July through December 2026, Kode is undergoing a major maintenance and refactoring phase.<br/>Follow releases and announcements for the refreshed roadmap.</sub>

</div>
