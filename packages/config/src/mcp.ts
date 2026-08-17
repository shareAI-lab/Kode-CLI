import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { memoize } from 'lodash-es'

import { safeParseJSON } from './json'
import { getCwd } from './cwd'

import type { McpServerConfig } from './schema'

export const TEST_MCPRC_CONFIG_FOR_TESTING: Record<string, McpServerConfig> = {}

export function clearMcprcConfigForTesting(): void {
  if (process.env.NODE_ENV !== 'test') return
  for (const key of Object.keys(TEST_MCPRC_CONFIG_FOR_TESTING)) {
    delete TEST_MCPRC_CONFIG_FOR_TESTING[key]
  }
}

export function addMcprcServerForTesting(
  name: string,
  server: McpServerConfig,
): void {
  if (process.env.NODE_ENV === 'test') {
    TEST_MCPRC_CONFIG_FOR_TESTING[name] = server
  }
}

export function removeMcprcServerForTesting(name: string): void {
  if (process.env.NODE_ENV !== 'test') return
  if (!TEST_MCPRC_CONFIG_FOR_TESTING[name]) {
    throw new Error(`No MCP server found with name: ${name} in .mcprc`)
  }
  delete TEST_MCPRC_CONFIG_FOR_TESTING[name]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export const getMcprcConfig = memoize(
  (): Record<string, McpServerConfig> => {
    if (process.env.NODE_ENV === 'test') return TEST_MCPRC_CONFIG_FOR_TESTING

    const mcprcPath = join(getCwd(), '.mcprc')
    if (!existsSync(mcprcPath)) return {}

    try {
      const mcprcContent = readFileSync(mcprcPath, 'utf-8')
      const parsed = safeParseJSON(mcprcContent)
      if (isRecord(parsed)) return parsed as Record<string, McpServerConfig>
    } catch {
      // ignore
    }
    return {}
  },
  () => {
    const cwd = getCwd()
    const mcprcPath = join(cwd, '.mcprc')
    if (!existsSync(mcprcPath)) return cwd
    try {
      return `${cwd}:${readFileSync(mcprcPath, 'utf-8')}`
    } catch {
      return cwd
    }
  },
)

export type ProjectMcpServerDefinitions = {
  servers: Record<string, McpServerConfig>
  sources: Record<string, '.mcp.json' | '.mcprc'>
  mcpJsonPath: string
  mcprcPath: string
}

function parseMcpServersFromMcpJson(
  value: unknown,
): Record<string, McpServerConfig> {
  if (!isRecord(value)) return {}
  const raw = value['mcpServers']
  if (!isRecord(raw)) return {}
  return raw as Record<string, McpServerConfig>
}

function parseMcpServersFromMcprc(
  value: unknown,
): Record<string, McpServerConfig> {
  if (!isRecord(value)) return {}
  const maybeNested = value['mcpServers']
  if (isRecord(maybeNested))
    return maybeNested as Record<string, McpServerConfig>
  return value as Record<string, McpServerConfig>
}

export const getProjectMcpServerDefinitions = memoize(
  (): ProjectMcpServerDefinitions => {
    if (process.env.NODE_ENV === 'test') {
      return {
        servers: {},
        sources: {},
        mcpJsonPath: join(getCwd(), '.mcp.json'),
        mcprcPath: join(getCwd(), '.mcprc'),
      }
    }

    const cwd = getCwd()
    const mcpJsonPath = join(cwd, '.mcp.json')
    const mcprcPath = join(cwd, '.mcprc')

    let mcpJsonServers: Record<string, McpServerConfig> = {}
    let mcprcServers: Record<string, McpServerConfig> = {}

    if (existsSync(mcpJsonPath)) {
      try {
        const parsed = safeParseJSON(readFileSync(mcpJsonPath, 'utf-8'))
        mcpJsonServers = parseMcpServersFromMcpJson(parsed)
      } catch {
        /* no-op */
      }
    }

    if (existsSync(mcprcPath)) {
      try {
        const parsed = safeParseJSON(readFileSync(mcprcPath, 'utf-8'))
        mcprcServers = parseMcpServersFromMcprc(parsed)
      } catch {
        /* no-op */
      }
    }

    const sources: Record<string, '.mcp.json' | '.mcprc'> = {}
    for (const name of Object.keys(mcpJsonServers)) sources[name] = '.mcp.json'
    for (const name of Object.keys(mcprcServers)) sources[name] = '.mcprc'

    return {
      servers: { ...mcpJsonServers, ...mcprcServers },
      sources,
      mcpJsonPath,
      mcprcPath,
    }
  },
  () => {
    const cwd = getCwd()
    const mcpJsonPath = join(cwd, '.mcp.json')
    const mcprcPath = join(cwd, '.mcprc')

    const parts: string[] = [cwd]

    if (existsSync(mcpJsonPath)) {
      try {
        parts.push('mcp.json', readFileSync(mcpJsonPath, 'utf-8'))
      } catch {
        /* no-op */
      }
    }

    if (existsSync(mcprcPath)) {
      try {
        parts.push('mcprc', readFileSync(mcprcPath, 'utf-8'))
      } catch {
        /* no-op */
      }
    }

    return parts.join(':')
  },
)
