import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { debug as debugLogger } from '#core/utils/debugLogger'
import { logError } from '#core/utils/log'
import { getKodeRoot } from '#config/dataRoots'
import { getEffectiveSessionId } from '@kode/runtime'

/**
 * Agent Storage Utilities
 * Provides file-based state isolation for different agents
 * Based on Kode's Agent ID architecture
 */

/**
 * Get the kode config directory
 */
function getConfigDirectory(): string {
  return getKodeRoot()
}

/**
 * Get the current session ID
 */
/**
 * Generate agent-specific file path
 * Pattern: ${sessionId}-agent-${agentId}.json
 * Stored in ~/.kode/ directory
 */
export function getAgentFilePath(agentId: string): string {
  const sessionId = getEffectiveSessionId()
  const filename = `${sessionId}-agent-${agentId}.json`
  const configDir = getConfigDirectory()

  // Ensure kode config directory exists
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true })
  }

  return join(configDir, filename)
}

/**
 * Read agent-specific data from storage
 */
export function readAgentData<T = any>(agentId: string): T | null {
  const filePath = getAgentFilePath(agentId)

  if (!existsSync(filePath)) {
    return null
  }

  try {
    const content = readFileSync(filePath, 'utf-8')
    return JSON.parse(content) as T
  } catch (error) {
    logError(error)
    debugLogger.warn('AGENT_STORAGE_READ_FAILED', {
      agentId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * Write agent-specific data to storage
 */
export function writeAgentData<T = any>(agentId: string, data: T): void {
  const filePath = getAgentFilePath(agentId)

  try {
    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
  } catch (error) {
    logError(error)
    debugLogger.warn('AGENT_STORAGE_WRITE_FAILED', {
      agentId,
      error: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

/**
 * Get default agent ID if none is provided
 */
export function getDefaultAgentId(): string {
  return 'default'
}

/**
 * Resolve agent ID from context
 */
export function resolveAgentId(agentId?: string): string {
  return agentId || getDefaultAgentId()
}

/**
 * Generate a new unique Agent ID
 */
export function generateAgentId(): string {
  return randomUUID()
}
