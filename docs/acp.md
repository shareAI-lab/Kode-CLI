# ACP (Agent Client Protocol)

Kode ships an ACP-compatible agent server (`kode-acp`) that speaks newline-delimited JSON-RPC 2.0 over stdio (ACP protocol v1).

This enables integration with ACP clients such as Toad TUI, Zed, and other editors supporting ACP.

## Install

```bash
npm install -g @shareai-lab/kode
```

## Run

```bash
kode-acp
# or
kode --acp
```

### Toad

```bash
toad acp "kode-acp"
```

## Supported ACP features

- Baseline: `initialize`, `session/new`, `session/prompt`, `session/cancel`, `session/update`
- Session loading: `session/load` (replays history via `session/update`)
- Session modes: `session/set_mode` maps to Kode permission modes (`default`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions`)
- Prompt resources: accepts `ContentBlock::resource` and `ContentBlock::resource_link`
- MCP servers: connects to `mcpServers` passed in `session/new` / `session/load` (stdio + HTTP + SSE + WebSocket)
- MCP client capabilities: ACP sessions advertise and serve **`roots`** using the session `cwd`, so servers that ask `roots/list` see the workspace the client opened. `elicitation` is **not** available over ACP — ACP has no generic server-to-client question primitive (only `session/request_permission`, which is not a substitute). `sampling` is also not available: it is a CLI-host capability.

## Session persistence

ACP sessions are persisted per-project, so `session/load` works across restarts.

- Default location: `~/.kode/<project-slug>/acp-sessions/<sessionId>.json`
- Override base dir: set `KODE_CONFIG_DIR`

## Tool calls & diffs (toad-friendly)

- Kode maps its internal tool lifecycle to ACP `tool_call` / `tool_call_update`.
- For file edits (`Write`, `Edit`, `MultiEdit`), Kode emits `ToolCallContent.type="diff"` (with absolute `path`, `oldText`, `newText`) on completion, so clients like Toad can render a DiffView.

## MCP servers

Clients may include MCP servers in `session/new` / `session/load`:

- **Stdio**:
  - `{ "name": "filesystem", "command": "/path/to/server", "args": ["--stdio"], "env": [{"name":"KEY","value":"..."}] }`
- **HTTP** (requires `agentCapabilities.mcpCapabilities.http`):
  - `{ "type": "http", "name": "api", "url": "https://…/mcp", "headers": [{"name":"Authorization","value":"Bearer …"}] }`
- **SSE** (requires `agentCapabilities.mcpCapabilities.sse`, deprecated upstream but supported):
  - `{ "type": "sse", "name": "events", "url": "https://…/mcp", "headers": [] }`
- **WebSocket** (requires `agentCapabilities.mcpCapabilities.ws`):
  - `{ "type": "ws", "name": "realtime", "url": "ws://…/mcp" }`

## stdout & logging

- **stdout is protocol-only**: ACP requires stdout to contain only JSON-RPC messages.
- Kode installs an ACP stdout guard that redirects accidental stdout writes (e.g. `console.log`) to **stderr** to avoid corrupting the protocol stream.

## Troubleshooting

- If the client reports invalid JSON-RPC / broken stream, inspect the agent process **stderr** output.
- Local testing without LLM/network: `KODE_ACP_ECHO=1 kode-acp` (echoes prompts back as assistant output).
- Useful env vars:
  - `KODE_ACP_PERMISSION_TIMEOUT_MS=60000` (permission prompt timeout)
  - `MCP_CONNECTION_TIMEOUT_MS=30000` (MCP connect timeout)
- Use Kode debug flags (stderr output + `~/.kode/.../debug` files):
  - `kode-acp --debug-verbose`
  - `kode-acp --debug`
