import { memoize } from 'lodash-es'
import type { ServerCapabilities } from '@modelcontextprotocol/sdk/types.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'

import type { McpServerConfig } from '#core/utils/config'
import { getCurrentProjectConfig, getGlobalConfig } from '#core/utils/config'
import { getCwd } from '#runtime/cwd'
import { logMCPError } from '@kode/logging/log/errors'

import {
  getMcprcServerStatus,
  getMcpServer,
  listMCPServers,
  parseMcpServersFromCliConfigEntries,
} from './config'
import { connectToServer } from './connection'
import { getMcpServerConnectionBatchSize } from './settings'
import type { WrappedClient } from './types'

let clientsOverrideForTests: WrappedClient[] | null = null

export const getClients = memoize(async (): Promise<WrappedClient[]> => {
  if (process.env.CI && process.env.NODE_ENV !== 'test') {
    return []
  }

  if (process.env.NODE_ENV === 'test' && clientsOverrideForTests) {
    return clientsOverrideForTests
  }

  const allServersRaw: Record<string, McpServerConfig> = {
    ...(listMCPServers() ?? {}),
  }

  const globalConfig = getGlobalConfig()
  const projectConfig = getCurrentProjectConfig()

  const disabledServers = new Set<string>([
    ...(globalConfig.disabledMcpServers ?? []),
    ...(projectConfig.disabledMcpServers ?? []),
  ])

  const allServers: Record<string, McpServerConfig> = Object.fromEntries(
    Object.entries(allServersRaw).filter(([name]) => {
      if (disabledServers.has(name)) return false
      if (name.startsWith('plugin_')) return true

      const scoped = getMcpServer(name)
      if (scoped?.scope === 'mcpjson' || scoped?.scope === 'mcprc') {
        return getMcprcServerStatus(name) === 'approved'
      }
      return true
    }),
  )

  const batchSize = getMcpServerConnectionBatchSize()
  const entries = Object.entries(allServers)
  const results: WrappedClient[] = []

  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize)
    const batchResults = await Promise.all(
      batch.map(async ([name, serverRef]) => {
        try {
          const client = await connectToServer(name, serverRef)
          let capabilities: ServerCapabilities | null = null
          try {
            capabilities = client.getServerCapabilities() ?? null
          } catch {
            capabilities = null
          }
          return { name, client, capabilities, type: 'connected' as const }
        } catch (error) {
          if (error instanceof UnauthorizedError) {
            logMCPError(name, 'Connection failed: authentication required')
            return { name, type: 'needs-auth' as const }
          }
          logMCPError(
            name,
            `Connection failed: ${error instanceof Error ? error.message : String(error)}`,
          )
          return { name, type: 'failed' as const }
        }
      }),
    )
    results.push(...batchResults)
  }

  return results
})

export function __setMcpClientsForTests(clients: WrappedClient[] | null): void {
  clientsOverrideForTests = clients
  getClients.cache.clear?.()
}

export async function getClientsForCliMcpConfig(options: {
  mcpConfig?: string[]
  strictMcpConfig?: boolean
  projectDir?: string
}): Promise<WrappedClient[]> {
  const projectDir = options.projectDir ?? getCwd()
  const entries =
    Array.isArray(options.mcpConfig) && options.mcpConfig.length > 0
      ? options.mcpConfig
      : []
  const strict = options.strictMcpConfig === true

  if (entries.length === 0 && !strict) {
    return getClients()
  }

  const cliServers = parseMcpServersFromCliConfigEntries({
    entries,
    projectDir,
  })

  const cliServerNames = new Set(Object.keys(cliServers))

  const baseServers: Record<string, McpServerConfig> = strict
    ? {}
    : listMCPServers()

  const globalConfig = strict ? null : getGlobalConfig()
  const projectConfig = strict ? null : getCurrentProjectConfig()

  const disabledServers = strict
    ? new Set<string>()
    : new Set<string>([
        ...((globalConfig?.disabledMcpServers ?? []) as string[]),
        ...((projectConfig?.disabledMcpServers ?? []) as string[]),
      ])

  const allServers: Record<string, McpServerConfig> = {
    ...(baseServers ?? {}),
    ...(cliServers ?? {}),
  }

  const batchSize = getMcpServerConnectionBatchSize()
  const entriesToConnect = Object.entries(allServers).filter(([name]) => {
    if (disabledServers.has(name)) return false
    if (cliServerNames.has(name)) return true
    if (name.startsWith('plugin_')) return true

    const scoped = getMcpServer(name)
    if (scoped?.scope === 'mcpjson' || scoped?.scope === 'mcprc') {
      return getMcprcServerStatus(name) === 'approved'
    }
    return true
  })
  const results: WrappedClient[] = []

  for (let i = 0; i < entriesToConnect.length; i += batchSize) {
    const batch = entriesToConnect.slice(i, i + batchSize)
    const batchResults = await Promise.all(
      batch.map(async ([name, serverRef]) => {
        try {
          const client = await connectToServer(name, serverRef)
          let capabilities: ServerCapabilities | null = null
          try {
            capabilities = client.getServerCapabilities() ?? null
          } catch {
            capabilities = null
          }
          return { name, client, capabilities, type: 'connected' as const }
        } catch (error) {
          if (error instanceof UnauthorizedError) {
            logMCPError(name, 'Connection failed: authentication required')
            return { name, type: 'needs-auth' as const }
          }
          logMCPError(
            name,
            `Connection failed: ${error instanceof Error ? error.message : String(error)}`,
          )
          return { name, type: 'failed' as const }
        }
      }),
    )
    results.push(...batchResults)
  }

  return results
}
