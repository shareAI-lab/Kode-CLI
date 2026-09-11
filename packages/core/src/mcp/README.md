# MCP integration

This module owns Kode's MCP client integration and the MCP server entrypoint.
`apps/cli/src/dispatch.ts` routes MCP modes here, and `scripts/build.mjs` bundles
`packages/core/src/mcp/index.ts` as `dist/entrypoints/mcp.js`.

Tool schemas are produced through the shared tooling model so interactive CLI,
print mode, and MCP transport expose consistent capability contracts.

## Adding a new transport

Transport construction lives in `transports/registry.ts` and is shared by both
the core client (`client/connection.ts`) and the ACP agent
(`apps/server/src/acp/agent/mcp.ts`). To add a transport:

1. Add the config discriminant in `packages/config/src/schema.ts`
   (`McpXxxServerConfig` + the `McpServerConfig` union).
2. Add a case in `createTransportCandidates` in
   `transports/registry.ts` (extend `TransportKind`/`TransportCandidate`).
3. Expose it in the CLI: `packages/core/src/services/mcpCliUtils.ts`
   (`McpCliTransport` + `normalizeMcpTransport`) and the `mcp add` command.
4. If ACP should support it, extend `McpServer`/`McpCapabilities` in
   `apps/server/src/acp/protocol/base.ts` and `handleInitialize`.
5. Document it in `docs/mcp.md` / `docs/acp.md`.

Capability handlers (roots / elicitation / sampling) are registered per client
in `client/capabilities/` and default to fail-closed when no host responder is
installed.
