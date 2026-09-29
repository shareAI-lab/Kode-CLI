import type { Buffer } from 'node:buffer'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { ServerCapabilities } from '@modelcontextprotocol/sdk/types.js'

import { MACRO } from '#core/constants/macros'
import { PRODUCT_COMMAND } from '#core/constants/product'
import { logError, logMCPError } from '#core/utils/log'
import {
  buildMcpRoots,
  registerCapabilityHandlers,
  type McpRoot,
  type WrappedClient,
} from '#core/mcp/client'
import type { McpServerConfig } from '#core/utils/config'
import { createTransportCandidates } from '#core/mcp/transports/registry'

import type * as Protocol from '../protocol'

function getConnectionTimeoutMs(): number {
  const rawTimeout = process.env.MCP_CONNECTION_TIMEOUT_MS
  const parsedTimeout = rawTimeout ? Number.parseInt(rawTimeout, 10) : NaN
  return Number.isFinite(parsedTimeout) ? parsedTimeout : 30_000
}

function normalizeHeaders(
  headers: Protocol.HttpHeader[] | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const h of headers ?? []) {
    if (!h || typeof h !== 'object') continue
    if (typeof h.name === 'string' && typeof h.value === 'string') {
      out[h.name] = h.value
    }
  }
  return out
}

function normalizeEnvVars(
  vars: Protocol.EnvVariable[] | undefined,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const v of vars ?? []) {
    if (!v || typeof v !== 'object') continue
    if (typeof v.name === 'string' && typeof v.value === 'string') {
      out[v.name] = v.value
    }
  }
  return out
}

async function connectWithTimeout(
  client: Client,
  transport: Transport,
  name: string,
  timeoutMs: number,
): Promise<void> {
  const connectPromise = client.connect(transport)
  if (timeoutMs <= 0) {
    await connectPromise
    return
  }

  const timeoutPromise = new Promise<never>((_, reject) => {
    const timeoutId = setTimeout(() => {
      reject(
        new Error(
          `Connection to MCP server "${name}" timed out after ${timeoutMs}ms`,
        ),
      )
    }, timeoutMs)

    connectPromise.finally(() => clearTimeout(timeoutId))
  })

  await Promise.race([connectPromise, timeoutPromise])
}

/**
 * Normalize an ACP-provided server descriptor into Kode's MCP config shape so
 * both hosts build transports through the same registry.
 */
export function toMcpServerConfig(
  server: Protocol.McpServer,
): McpServerConfig | null {
  if (!server.name) return null

  if (server.type === 'http' || server.type === 'sse' || server.type === 'ws') {
    const url = server.url
    if (!url) return null

    try {
      new URL(url)
    } catch (e) {
      logError(e)
      return null
    }

    if (server.type === 'ws') return { type: 'ws', url }

    const headers = normalizeHeaders(server.headers)
    const withHeaders = Object.keys(headers).length > 0 ? { headers } : {}

    if (server.type === 'http') return { type: 'http', url, ...withHeaders }
    return { type: 'sse', url, ...withHeaders }
  }

  const env = normalizeEnvVars(server.env)
  return {
    type: 'stdio',
    command: server.command,
    args: server.args,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  }
}

/**
 * Advertise the client capabilities Kode can actually serve over ACP.
 *
 * `roots` is available whenever the session has a working directory (the ACP
 * client supplies `cwd` per session). Elicitation is deliberately not
 * advertised: ACP has no generic server-to-client question primitive, only
 * `session/request_permission`, which is not a substitute.
 */
export function getAcpClientCapabilities(cwd: string): {
  roots?: { listChanged: boolean }
} {
  if (!cwd) return {}
  return { roots: { listChanged: false } }
}

/**
 * Build an ACP MCP client. The advertised capabilities and the registered
 * handlers come from the same object, because the SDK rejects a handler for a
 * capability the client did not declare.
 */
export function createAcpMcpClient(
  name: string,
  capabilities: ReturnType<typeof getAcpClientCapabilities>,
  getRoots: (serverName: string) => Promise<McpRoot[]>,
): Client {
  const client = new Client(
    { name: PRODUCT_COMMAND, version: MACRO.VERSION || '0.0.0' },
    { capabilities },
  )
  registerCapabilityHandlers(client, name, { capabilities, getRoots })
  return client
}

export async function connectAcpMcpServers(
  mcpServers: Protocol.McpServer[],
  options: { cwd?: string } = {},
): Promise<WrappedClient[]> {
  if (!Array.isArray(mcpServers) || mcpServers.length === 0) return []

  const cwd = options.cwd ?? ''
  const timeoutMs = getConnectionTimeoutMs()
  const results: WrappedClient[] = []
  const clientCapabilities = getAcpClientCapabilities(cwd)

  // Serve `roots/list` from the session working directory — the workspace the
  // ACP client (Zed, Toad) actually opened. It must never fall back to the
  // daemon's own roots, and an unknown/empty cwd exposes nothing.
  const getRoots = async (): Promise<McpRoot[]> =>
    cwd ? buildMcpRoots({ trusted: true, configured: [], cwd }) : []

  for (const server of mcpServers) {
    const config = toMcpServerConfig(server)
    const name = server.name
    if (!config || !name) {
      results.push({ name: '<invalid>', type: 'failed' })
      continue
    }

    const candidates = await createTransportCandidates(config)

    let lastError: unknown
    for (const candidate of candidates) {
      let client: Client
      try {
        client = createAcpMcpClient(name, clientCapabilities, getRoots)

        await connectWithTimeout(client, candidate.transport, name, timeoutMs)

        if (candidate.kind === 'stdio') {
          candidate.transport.stderr?.on('data', (data: Buffer) => {
            const errorText = data.toString().trim()
            if (errorText) logMCPError(name, `Server stderr: ${errorText}`)
          })
        }

        let serverCapabilities: ServerCapabilities | null = null
        try {
          serverCapabilities = client.getServerCapabilities() ?? null
        } catch {
          serverCapabilities = null
        }

        results.push({
          name,
          client,
          capabilities: serverCapabilities,
          type: 'connected' as const,
        })
        lastError = null
        break
      } catch (e) {
        lastError = e
        try {
          await client.close()
        } catch {}
      }
    }

    if (lastError) {
      logError(lastError)
      results.push({ name, type: 'failed' as const })
    }
  }

  return results
}

export function mergeMcpClients(
  base: WrappedClient[],
  extra: WrappedClient[],
): WrappedClient[] {
  const map = new Map<string, WrappedClient>()
  for (const c of base) map.set(c.name, c)
  for (const c of extra) map.set(c.name, c)
  return Array.from(map.values())
}
