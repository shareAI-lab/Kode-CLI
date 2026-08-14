# packages/host-mcp

MCP host/transport 适配：

- MCP server/client
- tool schema 来自统一 ToolSpec

入口：

- `apps/kode/src/entrypoints/mcp.ts` / `apps/kode/src/entrypoints/mcpServer.ts`

关键点：

- 工具 schema 通过 `packages/core/src/tooling/mcpToolSchema.ts` 统一生成，避免多端不一致。
