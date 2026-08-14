import { MCP_DEFAULTS, type McpServerConfig } from '#core/utils/config'
import { debug } from '@kode/logging'
import {
  captureMcpCapabilities,
  closeMcpClient,
  connectMcpServer,
  getMcpConnectionTimeoutMs,
  getMcpServerConnectionBatchSize,
} from './connection'
import type { WrappedClient } from './types'

type ManagedClientEntry = {
  configKey: string
  serverRef: McpServerConfig
  wrapped: WrappedClient
  lastConnectAttemptAt: number
  lastHealthCheckAt: number
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => a.localeCompare(b),
  )
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')}}`
}

function serverConfigKey(name: string, serverRef: McpServerConfig): string {
  return `${name}:${stableStringify(serverRef)}`
}

async function closeWrappedClient(client: WrappedClient): Promise<void> {
  if (client.type !== 'connected') return
  await closeMcpClient(client.client)
}

async function pingWrappedClient(client: WrappedClient): Promise<boolean> {
  if (client.type !== 'connected') return false

  const configuredTimeoutMs = getMcpConnectionTimeoutMs()
  const timeoutMs =
    configuredTimeoutMs > 0 ? Math.min(configuredTimeoutMs, 5_000) : 5_000

  try {
    await client.client.ping({ timeout: timeoutMs })
    client.capabilities = captureMcpCapabilities(client.client)
    return true
  } catch {
    return false
  }
}

export class MCPClientManager {
  private readonly clients = new Map<string, ManagedClientEntry>()
  private readonly connector: typeof connectMcpServer

  constructor(connector?: typeof connectMcpServer) {
    this.connector = connector ?? connectMcpServer
  }

  async getClientsForServers(
    servers: Record<string, McpServerConfig>,
    options?: { clientVersion?: string; closeMissing?: boolean },
  ): Promise<WrappedClient[]> {
    const entries = Object.entries(servers)
    const activeNames = new Set(entries.map(([name]) => name))

    if (options?.closeMissing !== false) {
      for (const [name, entry] of this.clients.entries()) {
        if (activeNames.has(name)) continue
        this.clients.delete(name)
        void closeWrappedClient(entry.wrapped).catch(err =>
          debug.warn('MCP_MANAGER_CLOSE_FAILED', {
            server: name,
            error: String(err),
          }),
        )
      }
    }

    const batchSize = getMcpServerConnectionBatchSize()
    const results: WrappedClient[] = []

    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = entries.slice(i, i + batchSize)
      const startedAt = Date.now()

      debug.info('MCP_MANAGER_BATCH_START', {
        offset: i,
        size: batch.length,
        total: entries.length,
      })

      const batchResults = await Promise.all(
        batch.map(([name, serverRef]) =>
          this.getClientForServer(name, serverRef, options),
        ),
      )

      debug.info('MCP_MANAGER_BATCH_DONE', {
        offset: i,
        size: batch.length,
        durationMs: Date.now() - startedAt,
        connected: batchResults.filter(result => result.type === 'connected')
          .length,
        failed: batchResults.filter(result => result.type === 'failed').length,
      })

      results.push(...batchResults)
    }

    return results
  }

  clear(): void {
    for (const [name, entry] of this.clients.entries()) {
      void closeWrappedClient(entry.wrapped).catch(err =>
        debug.warn('MCP_MANAGER_CLOSE_FAILED', {
          server: name,
          error: String(err),
        }),
      )
    }
    this.clients.clear()
  }

  private async getClientForServer(
    name: string,
    serverRef: McpServerConfig,
    options?: { clientVersion?: string },
  ): Promise<WrappedClient> {
    const now = Date.now()
    const configKey = serverConfigKey(name, serverRef)
    const existing = this.clients.get(name)

    if (existing && existing.configKey !== configKey) {
      this.clients.delete(name)
      void closeWrappedClient(existing.wrapped).catch(err =>
        debug.warn('MCP_MANAGER_CLOSE_FAILED', {
          server: name,
          error: String(err),
        }),
      )
    } else if (existing) {
      if (existing.wrapped.type === 'connected') {
        if (
          now - existing.lastHealthCheckAt <
          MCP_DEFAULTS.healthCheckIntervalMs
        ) {
          return existing.wrapped
        }

        existing.lastHealthCheckAt = now
        const healthy = await pingWrappedClient(existing.wrapped)
        if (healthy) return existing.wrapped

        debug.warn('MCP_MANAGER_RECONNECT_AFTER_PING_FAILED', {
          server: name,
        })
        this.clients.delete(name)
        void closeWrappedClient(existing.wrapped).catch(err =>
          debug.warn('MCP_MANAGER_CLOSE_FAILED', {
            server: name,
            error: String(err),
          }),
        )
      } else if (
        now - existing.lastConnectAttemptAt <
        MCP_DEFAULTS.failedRetryIntervalMs
      ) {
        return existing.wrapped
      }
    }

    const wrapped = await this.connector(name, serverRef, {
      clientVersion: options?.clientVersion,
    })
    this.clients.set(name, {
      configKey,
      serverRef,
      wrapped,
      lastConnectAttemptAt: now,
      lastHealthCheckAt: now,
    })

    return wrapped
  }
}
