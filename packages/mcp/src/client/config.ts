import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  addMcprcServerForTesting,
  getCurrentProjectConfig,
  getGlobalConfig,
  getProjectMcpServerDefinitions,
  type McpServerConfig,
  removeMcprcServerForTesting,
  saveCurrentProjectConfig,
  saveGlobalConfig,
} from '#core/utils/config'
import { safeParseJSON } from '#core/utils/json'
import { getSessionPlugins } from '#core/utils/sessionPlugins'
import { getCwd } from '#runtime/cwd'

import { loadLegacyClaudeJsonConfig } from '#config/compat/legacyClaudeJson'

import type { McpName } from './settings'
import { ensureConfigScope, type ConfigScope } from '../scopes'
export { ensureConfigScope }
import { expandTemplateDeep, isRecord, parseJsonOrJsonc } from './utils'

export type ScopedMcpServerConfig = McpServerConfig & {
  scope: ConfigScope
  configLocation?: string
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed) continue
    out.push(trimmed)
  }
  return out
}

function findLegacyClaudeProjectEntry(projectDir: string): {
  projectPath: string
  entry: Record<string, unknown>
  configPath: string
} | null {
  const loaded = loadLegacyClaudeJsonConfig()
  const configPath = loaded.usedPath
  const config = loaded.config
  if (!configPath || !config) return null

  const projectsRaw = config['projects']
  if (!isRecord(projectsRaw)) return null

  let currentPath = resolve(projectDir)
  while (true) {
    const entry = projectsRaw[currentPath]
    if (isRecord(entry)) {
      return { projectPath: currentPath, entry, configPath }
    }

    const parentPath = resolve(currentPath, '..')
    if (parentPath === currentPath) break
    currentPath = parentPath
  }

  return null
}

function getLegacyClaudeUserMcpServers(): {
  servers: Record<string, McpServerConfig>
  configPath: string | null
} {
  const loaded = loadLegacyClaudeJsonConfig()
  const configPath = loaded.usedPath
  const config = loaded.config
  if (!configPath || !config) return { servers: {}, configPath: null }

  const rawServers = config['mcpServers']
  if (!isRecord(rawServers)) return { servers: {}, configPath }
  return { servers: rawServers as Record<string, McpServerConfig>, configPath }
}

function getLegacyClaudeLocalMcpServers(projectDir: string): {
  servers: Record<string, McpServerConfig>
  configPath: string | null
  projectPath: string | null
} {
  const entry = findLegacyClaudeProjectEntry(projectDir)
  if (!entry) return { servers: {}, configPath: null, projectPath: null }

  const rawServers = entry.entry['mcpServers']
  if (!isRecord(rawServers))
    return {
      servers: {},
      configPath: entry.configPath,
      projectPath: entry.projectPath,
    }

  return {
    servers: rawServers as Record<string, McpServerConfig>,
    configPath: entry.configPath,
    projectPath: entry.projectPath,
  }
}

function getLegacyClaudeProjectMcpjsonChoice(
  projectDir: string,
  serverName: string,
  options?: { includeEnableAll?: boolean },
): 'approved' | 'rejected' | 'pending' {
  const entry = findLegacyClaudeProjectEntry(projectDir)
  if (!entry) return 'pending'

  const enableAll = Boolean(entry.entry['enableAllProjectMcpServers'])
  if (options?.includeEnableAll !== false && enableAll) return 'approved'

  const enabled = parseStringArray(entry.entry['enabledMcpjsonServers'])
  if (enabled.includes(serverName)) return 'approved'

  const disabled = parseStringArray(entry.entry['disabledMcpjsonServers'])
  if (disabled.includes(serverName)) return 'rejected'

  return 'pending'
}

export function parseEnvVars(
  rawEnvArgs: string[] | undefined,
): Record<string, string> {
  const parsedEnv: Record<string, string> = {}

  if (!rawEnvArgs) return parsedEnv

  for (const envStr of rawEnvArgs) {
    const [key, ...valueParts] = envStr.split('=')
    if (!key || valueParts.length === 0) {
      throw new Error(
        `Invalid environment variable format: ${envStr}, environment variables should be added as: -e KEY1=value1 -e KEY2=value2`,
      )
    }
    parsedEnv[key] = valueParts.join('=')
  }

  return parsedEnv
}

export function listPluginMCPServers(): Record<string, McpServerConfig> {
  const plugins = getSessionPlugins()
  if (plugins.length === 0) return {}

  const out: Record<string, McpServerConfig> = {}

  for (const plugin of plugins) {
    const pluginRoot = plugin.rootDir
    const pluginName = plugin.name

    const configs: Array<Record<string, McpServerConfig>> = []

    for (const configPath of plugin.mcpConfigFiles ?? []) {
      try {
        const raw = readFileSync(configPath, 'utf8')
        const parsed = parseJsonOrJsonc(raw)
        if (!isRecord(parsed)) continue

        const maybeNested = parsed['mcpServers']
        const rawServers = isRecord(maybeNested) ? maybeNested : parsed
        if (!isRecord(rawServers)) continue

        const servers: Record<string, McpServerConfig> = {}
        for (const [name, cfg] of Object.entries(rawServers)) {
          if (!isRecord(cfg)) continue
          servers[name] = expandTemplateDeep(cfg, pluginRoot) as McpServerConfig
        }
        configs.push(servers)
      } catch {
        continue
      }
    }

    if (isRecord(plugin.manifest)) {
      const manifestRaw = plugin.manifest['mcpServers']
      if (isRecord(manifestRaw)) {
        const maybeNested = manifestRaw['mcpServers']
        const rawServers = isRecord(maybeNested) ? maybeNested : manifestRaw
        if (isRecord(rawServers)) {
          const servers: Record<string, McpServerConfig> = {}
          for (const [name, cfg] of Object.entries(rawServers)) {
            if (!isRecord(cfg)) continue
            servers[name] = expandTemplateDeep(
              cfg,
              pluginRoot,
            ) as McpServerConfig
          }
          configs.push(servers)
        }
      }
    }

    const merged: Record<string, McpServerConfig> = Object.assign(
      {},
      ...configs,
    )

    for (const [serverName, cfg] of Object.entries(merged)) {
      const fullName = `plugin_${pluginName}_${serverName}`
      out[fullName] = cfg
    }
  }

  return out
}

export function getMcprcServerStatus(
  serverName: string,
): 'approved' | 'rejected' | 'pending' {
  const config = getCurrentProjectConfig()
  if (config.approvedMcprcServers?.includes(serverName)) {
    return 'approved'
  }
  if (config.rejectedMcprcServers?.includes(serverName)) {
    return 'rejected'
  }

  const projectDefs = getProjectMcpServerDefinitions()
  if (projectDefs.sources[serverName] === '.mcp.json') {
    return getLegacyClaudeProjectMcpjsonChoice(getCwd(), serverName)
  }

  if (!projectDefs.sources[serverName]) {
    const legacyMcpjsonChoice = getLegacyClaudeProjectMcpjsonChoice(
      getCwd(),
      serverName,
      { includeEnableAll: false },
    )
    if (legacyMcpjsonChoice !== 'pending') return legacyMcpjsonChoice
  }

  return 'pending'
}

export function addMcpServer(
  name: McpName,
  server: McpServerConfig,
  scope: ConfigScope = 'project',
): void {
  if (scope === 'mcprc') {
    if (process.env.NODE_ENV === 'test') {
      addMcprcServerForTesting(name, server)
      return
    }

    const mcprcPath = join(getCwd(), '.mcprc')
    let mcprcConfig: Record<string, McpServerConfig> = {}

    if (existsSync(mcprcPath)) {
      try {
        const mcprcContent = readFileSync(mcprcPath, 'utf-8')
        const existingConfig = safeParseJSON(mcprcContent)
        if (isRecord(existingConfig)) {
          mcprcConfig = existingConfig as Record<string, McpServerConfig>
        }
      } catch {
        // ignore
      }
    }

    mcprcConfig[name] = server

    try {
      writeFileSync(mcprcPath, JSON.stringify(mcprcConfig, null, 2), 'utf-8')
    } catch (error) {
      throw new Error(`Failed to write to .mcprc: ${error}`)
    }

    return
  }

  if (scope === 'mcpjson') {
    const mcpJsonPath = join(getCwd(), '.mcp.json')
    let config: Record<string, unknown> = { mcpServers: {} }

    if (existsSync(mcpJsonPath)) {
      try {
        const content = readFileSync(mcpJsonPath, 'utf-8')
        const parsed = safeParseJSON(content)
        if (isRecord(parsed)) config = parsed
      } catch {
        // ignore
      }
    }

    const rawServers = config['mcpServers']
    const servers: Record<string, McpServerConfig> = isRecord(rawServers)
      ? (rawServers as Record<string, McpServerConfig>)
      : {}

    servers[name] = server
    config['mcpServers'] = servers

    try {
      writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2), 'utf-8')
    } catch (error) {
      throw new Error(`Failed to write to .mcp.json: ${error}`)
    }

    return
  }

  if (scope === 'global') {
    const config = getGlobalConfig()
    if (!config.mcpServers) config.mcpServers = {}
    config.mcpServers[name] = server
    saveGlobalConfig(config)
    return
  }

  const config = getCurrentProjectConfig()
  if (!config.mcpServers) config.mcpServers = {}
  config.mcpServers[name] = server
  saveCurrentProjectConfig(config)
}

export function removeMcpServer(
  name: McpName,
  scope: ConfigScope = 'project',
): void {
  if (scope === 'mcprc') {
    if (process.env.NODE_ENV === 'test') {
      removeMcprcServerForTesting(name)
      return
    }

    const mcprcPath = join(getCwd(), '.mcprc')
    if (!existsSync(mcprcPath)) {
      throw new Error('No .mcprc file found in this directory')
    }

    const mcprcContent = readFileSync(mcprcPath, 'utf-8')
    const parsed = safeParseJSON(mcprcContent)
    if (!isRecord(parsed) || !(name in parsed)) {
      throw new Error(`No MCP server found with name: ${name} in .mcprc`)
    }

    delete parsed[name]
    writeFileSync(mcprcPath, JSON.stringify(parsed, null, 2), 'utf-8')
    return
  }

  if (scope === 'mcpjson') {
    const mcpJsonPath = join(getCwd(), '.mcp.json')
    if (!existsSync(mcpJsonPath)) {
      throw new Error('No .mcp.json file found in this directory')
    }

    const content = readFileSync(mcpJsonPath, 'utf-8')
    const parsed = safeParseJSON(content)
    if (!isRecord(parsed)) {
      throw new Error('Invalid .mcp.json format')
    }

    const rawServers = parsed['mcpServers']
    if (!isRecord(rawServers) || !(name in rawServers)) {
      throw new Error(`No MCP server found with name: ${name} in .mcp.json`)
    }

    delete rawServers[name]
    parsed['mcpServers'] = rawServers
    writeFileSync(mcpJsonPath, JSON.stringify(parsed, null, 2), 'utf-8')
    return
  }

  if (scope === 'global') {
    const config = getGlobalConfig()
    if (!config.mcpServers?.[name]) {
      throw new Error(`No MCP server found with name: ${name} in global config`)
    }
    delete config.mcpServers[name]
    saveGlobalConfig(config)
    return
  }

  const config = getCurrentProjectConfig()
  if (!config.mcpServers?.[name]) {
    throw new Error(`No MCP server found with name: ${name} in project config`)
  }
  delete config.mcpServers[name]
  saveCurrentProjectConfig(config)
}

export function listMCPServers(): Record<string, McpServerConfig> {
  const pluginServers = listPluginMCPServers()
  const legacyUser = getLegacyClaudeUserMcpServers().servers
  const projectFileConfig = getProjectMcpServerDefinitions().servers
  const legacyLocal = getLegacyClaudeLocalMcpServers(getCwd()).servers
  const globalConfig = getGlobalConfig()
  const projectConfig = getCurrentProjectConfig()
  return {
    ...(pluginServers ?? {}),
    ...(legacyUser ?? {}),
    ...(legacyLocal ?? {}),
    ...(globalConfig.mcpServers ?? {}),
    ...(projectFileConfig ?? {}),
    ...(projectConfig.mcpServers ?? {}),
  }
}

export function getMcpServer(name: McpName): ScopedMcpServerConfig | undefined {
  const projectConfig = getCurrentProjectConfig()
  const projectFileDefinitions = getProjectMcpServerDefinitions()
  const projectFileConfig = projectFileDefinitions.servers
  const globalConfig = getGlobalConfig()
  const cwd = getCwd()

  if (projectConfig.mcpServers?.[name]) {
    return { ...projectConfig.mcpServers[name], scope: 'project' }
  }

  if (projectFileConfig?.[name]) {
    const source = projectFileDefinitions.sources[name]
    const scope: ConfigScope = source === '.mcp.json' ? 'mcpjson' : 'mcprc'
    return { ...projectFileConfig[name], scope }
  }

  if (globalConfig.mcpServers?.[name]) {
    return { ...globalConfig.mcpServers[name], scope: 'global' }
  }

  const legacyLocal = getLegacyClaudeLocalMcpServers(cwd)
  if (legacyLocal.servers?.[name] && legacyLocal.configPath) {
    return {
      ...legacyLocal.servers[name],
      scope: 'project',
      configLocation: `${legacyLocal.configPath} [project: ${legacyLocal.projectPath ?? cwd}]`,
    }
  }

  const legacyUser = getLegacyClaudeUserMcpServers()
  if (legacyUser.servers?.[name] && legacyUser.configPath) {
    return {
      ...legacyUser.servers[name],
      scope: 'global',
      configLocation: `${legacyUser.configPath}${
        existsSync(legacyUser.configPath) ? '' : ' (file does not exist)'
      }`,
    }
  }

  return undefined
}

export function parseMcpServersFromCliConfigEntries(options: {
  entries: string[]
  projectDir: string
}): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {}

  for (const rawEntry of options.entries) {
    const entry = String(rawEntry ?? '').trim()
    if (!entry) continue

    const resolvedPath = resolve(options.projectDir, entry)
    const payload = existsSync(resolvedPath)
      ? readFileSync(resolvedPath, 'utf8')
      : existsSync(entry)
        ? readFileSync(entry, 'utf8')
        : entry

    const parsed = parseJsonOrJsonc(payload)
    if (!isRecord(parsed)) continue

    const maybeNested = parsed['mcpServers']
    const rawServers = isRecord(maybeNested) ? maybeNested : parsed
    if (!isRecord(rawServers)) continue

    for (const [name, cfg] of Object.entries(rawServers)) {
      if (!isRecord(cfg)) continue
      out[name] = cfg as McpServerConfig
    }
  }

  return out
}
