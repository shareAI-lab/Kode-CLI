import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { randomUUID } from 'node:crypto'
import { join } from 'path'
import { homedir } from 'os'

import { getCwd } from '#core/utils/state'
import type { AgentConfig } from '@kode/agent'
import { debug as debugLogger } from '#core/utils/debugLogger'
import { logError } from '#core/utils/log'
import { LEGACY_CONFIG_DIRNAME } from '#core/compat/legacyPaths'

import { generateAgentFileContent } from './generation'

export type AgentLocation = 'user' | 'project'

const PRIMARY_FOLDER = '.kode'
const LEGACY_FOLDER = LEGACY_CONFIG_DIRNAME
const AGENTS_DIR = 'agents'

export function getAgentDirectory(location: AgentLocation): string {
  if (location === 'user') {
    return join(homedir(), PRIMARY_FOLDER, AGENTS_DIR)
  }
  return join(getCwd(), PRIMARY_FOLDER, AGENTS_DIR)
}

function getLegacyAgentDirectory(location: AgentLocation): string {
  if (location === 'user') {
    return join(homedir(), LEGACY_FOLDER, AGENTS_DIR)
  }
  return join(getCwd(), LEGACY_FOLDER, AGENTS_DIR)
}

export function getPrimaryAgentFilePath(
  location: AgentLocation,
  agentType: string,
): string {
  return join(getAgentDirectory(location), `${agentType}.md`)
}

function getLegacyAgentFilePath(
  location: AgentLocation,
  agentType: string,
): string {
  return join(getLegacyAgentDirectory(location), `${agentType}.md`)
}

export function getAgentFilePath(agent: AgentConfig): string {
  if (agent.location === 'built-in' || agent.location === 'plugin') {
    throw new Error(`Cannot get file path for ${agent.location} agents`)
  }

  const location = agent.location as AgentLocation
  const primary = getPrimaryAgentFilePath(location, agent.agentType)
  if (existsSync(primary)) return primary

  const legacy = getLegacyAgentFilePath(location, agent.agentType)
  if (existsSync(legacy)) return legacy

  return primary
}

export function ensureDirectoryExists(location: AgentLocation): string {
  const dir = getAgentDirectory(location)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  try {
    chmodSync(dir, 0o700)
  } catch {
    // Best-effort on filesystems without POSIX mode support.
  }
  return dir
}

export async function saveAgent(
  location: AgentLocation,
  agentType: string,
  description: string,
  tools: string[],
  systemPrompt: string,
  model?: string,
  color?: string,
  throwIfExists: boolean = true,
): Promise<void> {
  ensureDirectoryExists(location)

  const filePath = getPrimaryAgentFilePath(location, agentType)
  const legacyPath = getLegacyAgentFilePath(location, agentType)

  if (throwIfExists && (existsSync(filePath) || existsSync(legacyPath))) {
    throw new Error(`Agent file already exists: ${filePath}`)
  }

  const tempFile = `${filePath}.tmp.${Date.now()}.${Math.random()
    .toString(36)
    .substr(2, 9)}`

  const toolsForFile: string[] | '*' =
    Array.isArray(tools) && tools.length === 1 && tools[0] === '*' ? '*' : tools
  const content = generateAgentFileContent(
    agentType,
    description,
    toolsForFile,
    systemPrompt,
    model,
    color,
  )

  try {
    writeFileSync(tempFile, content, {
      encoding: 'utf-8',
      flag: 'wx',
      mode: 0o600,
    })

    if (throwIfExists && (existsSync(filePath) || existsSync(legacyPath))) {
      try {
        unlinkSync(tempFile)
      } catch {
        /* no-op */
      }
      throw new Error(`Agent file already exists: ${filePath}`)
    }

    renameSync(tempFile, filePath)
    try {
      chmodSync(filePath, 0o600)
    } catch {
      // Best-effort on filesystems without POSIX mode support.
    }
  } catch (error) {
    try {
      if (existsSync(tempFile)) {
        unlinkSync(tempFile)
      }
    } catch (cleanupError) {
      logError(cleanupError)
      debugLogger.warn('AGENT_STORAGE_TEMP_CLEANUP_FAILED', {
        error:
          cleanupError instanceof Error
            ? cleanupError.message
            : String(cleanupError),
      })
    }
    throw error
  }
}

export async function updateAgent(
  agent: AgentConfig,
  description: string,
  tools: string[] | '*',
  systemPrompt: string,
  color?: string,
  model?: string,
): Promise<void> {
  if (agent.location === 'built-in' || agent.location === 'plugin') {
    throw new Error(`Cannot update ${agent.location} agents`)
  }

  const toolsForFile = tools.length === 1 && tools[0] === '*' ? '*' : tools
  const content = generateAgentFileContent(
    agent.agentType,
    description,
    toolsForFile,
    systemPrompt,
    model,
    color,
    {
      disallowedTools: agent.disallowedTools,
      skills: agent.skills,
      permissionMode: agent.permissionMode,
      forkContext: agent.forkContext,
      maxExecutionTimeMs: agent.maxExecutionTimeMs,
    },
  )

  const location = agent.location as AgentLocation
  const primaryPath = getPrimaryAgentFilePath(location, agent.agentType)

  ensureDirectoryExists(location)
  const temporaryPath = `${primaryPath}.tmp.${process.pid}.${randomUUID()}`
  try {
    writeFileSync(temporaryPath, content, {
      encoding: 'utf-8',
      flag: 'wx',
      mode: 0o600,
    })
    renameSync(temporaryPath, primaryPath)
    try {
      chmodSync(primaryPath, 0o600)
    } catch {
      // Best-effort on filesystems without POSIX mode support.
    }
  } catch (error) {
    try {
      unlinkSync(temporaryPath)
    } catch {
      // Best-effort cleanup.
    }
    throw error
  }
}

export async function deleteAgent(agent: AgentConfig): Promise<void> {
  if (agent.location === 'built-in' || agent.location === 'plugin') {
    throw new Error(`Cannot delete ${agent.location} agents`)
  }

  const location = agent.location as AgentLocation
  const primaryPath = getPrimaryAgentFilePath(location, agent.agentType)
  const legacyPath = getLegacyAgentFilePath(location, agent.agentType)

  if (existsSync(primaryPath)) {
    unlinkSync(primaryPath)
    return
  }

  if (existsSync(legacyPath)) {
    throw new Error(
      `Cannot delete legacy agent "${agent.agentType}" from .claude. Legacy agents are read-only; remove it manually or create a .kode override.`,
    )
  }
}
