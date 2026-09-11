import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js'

import type { McpServerConfig } from '#core/utils/config'

/**
 * The wire transports Kode can speak as an MCP client.
 *
 * `stdio` and `http` (Streamable HTTP) are the two standard transports in the
 * 2025-11-25 spec; `sse` is the legacy HTTP+SSE transport; `ws` is a custom
 * transport that the TypeScript SDK is deprecating upstream (see
 * `createWebSocketTransport`).
 */
export type TransportKind = 'stdio' | 'sse' | 'http' | 'ws'

export type TransportCandidate =
  | { kind: 'stdio'; transport: StdioClientTransport }
  | { kind: 'sse'; transport: SSEClientTransport }
  | { kind: 'http'; transport: StreamableHTTPClientTransport }
  | { kind: 'ws'; transport: WebSocketClientTransport }

export type TransportBuildContext = {
  /**
   * OAuth 2.0 provider. When omitted (e.g. for ACP-provided servers) the
   * transport is built without auth and cannot perform the OAuth flow.
   */
  authProvider?: OAuthClientProvider
  /** Static request headers for HTTP/SSE transports. */
  headers?: Record<string, string>
}

type GlobalWithWebSocket = { WebSocket?: unknown }

async function ensureWebSocketGlobal(): Promise<void> {
  const global = globalThis as unknown as GlobalWithWebSocket
  if (typeof global.WebSocket === 'function') return

  try {
    const undiciModule = await import('undici')
    const maybeWs = (undiciModule as unknown as GlobalWithWebSocket).WebSocket
    if (typeof maybeWs === 'function') {
      global.WebSocket = maybeWs
    }
  } catch {
    // ignore
  }
}

function buildStdioEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  if (extra) Object.assign(env, extra)
  return env
}

/**
 * Headers for HTTP/SSE transports.
 *
 * `ctx.headers` carries the headers the core client resolved (static config
 * headers merged with any `headersHelper` output). Hosts that do not resolve
 * headers separately — the ACP agent passes config through untouched — fall back
 * to the headers declared on the server config itself.
 */
function resolveHeaderOptions(
  serverRef: McpServerConfig,
  ctx: TransportBuildContext,
): Record<string, string> | undefined {
  const headers =
    ctx.headers ??
    ('headers' in serverRef && serverRef.headers
      ? serverRef.headers
      : undefined)

  return headers && Object.keys(headers).length > 0 ? headers : undefined
}

function buildStreamableOptions(
  serverRef: McpServerConfig,
  ctx: TransportBuildContext,
): {
  authProvider?: OAuthClientProvider
  requestInit?: { headers: Record<string, string> }
} {
  const options: {
    authProvider?: OAuthClientProvider
    requestInit?: { headers: Record<string, string> }
  } = {}

  if (ctx.authProvider) options.authProvider = ctx.authProvider

  const headers = resolveHeaderOptions(serverRef, ctx)
  if (headers) options.requestInit = { headers }

  return options
}

async function createWebSocketTransport(
  url: string,
): Promise<WebSocketClientTransport> {
  await ensureWebSocketGlobal()
  try {
    // Dynamic import so a future SDK upgrade that removes
    // `client/websocket.js` degrades gracefully instead of crashing at startup.
    const { WebSocketClientTransport } =
      await import('@modelcontextprotocol/sdk/client/websocket.js')
    return new WebSocketClientTransport(new URL(url))
  } catch (error) {
    throw new Error(
      `WebSocket transport is unavailable in this MCP SDK build: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

function resolveWsIdeUrl(serverRef: {
  url: string
  authToken?: string
}): string {
  let url = serverRef.url
  if (serverRef.authToken) {
    try {
      const parsed = new URL(url)
      if (!parsed.searchParams.has('authToken')) {
        parsed.searchParams.set('authToken', serverRef.authToken)
        url = parsed.toString()
      }
    } catch {
      // ignore
    }
  }
  return url
}

/**
 * Build the ordered transport candidates for a configured MCP server.
 *
 * URL-based transports return an ordered fallback list (e.g. Streamable HTTP
 * first, legacy SSE second) so that `connectToServer` can try each in turn.
 * This is the single source of truth for transport construction: both the core
 * client (`client/connection.ts`) and the ACP agent (`apps/server` /
 * `acp/agent/mcp.ts`) route through here so they cannot drift.
 */
export async function createTransportCandidates(
  serverRef: McpServerConfig,
  ctx: TransportBuildContext = {},
): Promise<TransportCandidate[]> {
  switch (serverRef.type) {
    case 'sse': {
      const options = buildStreamableOptions(serverRef, ctx)
      const url = new URL(serverRef.url)
      return [
        { kind: 'sse', transport: new SSEClientTransport(url, options) },
        {
          kind: 'http',
          transport: new StreamableHTTPClientTransport(url, options),
        },
      ]
    }
    case 'sse-ide': {
      const options = buildStreamableOptions(serverRef, ctx)
      const url = new URL(serverRef.url)
      return [{ kind: 'sse', transport: new SSEClientTransport(url, options) }]
    }
    case 'http': {
      const options = buildStreamableOptions(serverRef, ctx)
      const url = new URL(serverRef.url)
      return [
        {
          kind: 'http',
          transport: new StreamableHTTPClientTransport(url, options),
        },
        { kind: 'sse', transport: new SSEClientTransport(url, options) },
      ]
    }
    case 'ws': {
      return [
        {
          kind: 'ws',
          transport: await createWebSocketTransport(serverRef.url),
        },
      ]
    }
    case 'ws-ide': {
      return [
        {
          kind: 'ws',
          transport: await createWebSocketTransport(resolveWsIdeUrl(serverRef)),
        },
      ]
    }
    case 'stdio':
    default: {
      const ref = serverRef
      return [
        {
          kind: 'stdio',
          transport: new StdioClientTransport({
            command: ref.command,
            args: ref.args,
            env: buildStdioEnv(ref.env),
            stderr: 'pipe',
          }),
        },
      ]
    }
  }
}
