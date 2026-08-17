import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'

import * as Protocol from './protocol'

import type { Message } from '#core/query'
import type { ToolUseContext } from '#core/tooling/Tool'
import { getKodeBaseDir } from '#core/utils/env'
import { logError } from '#core/utils/log'
import { debug } from '#core/utils/debugLogger'
import type { ToolPermissionContext } from '#core/types/toolPermissionContext'

export const ACP_SESSION_STORE_VERSION = 1
export const ACP_SESSION_TTL_MS = 24 * 60 * 60 * 1000

export type PersistedAcpSession = {
  version: number
  sessionId: string
  cwd: string
  mcpServers: Protocol.McpServer[]
  messages: Message[]
  toolPermissionContext: ToolPermissionContext
  readFileTimestamps: Record<string, number>
  responseState: ToolUseContext['responseState']
  currentModeId: Protocol.SessionModeId
}

export type AcpSessionPersistSource = {
  sessionId: string
  cwd: string
  mcpServers: Protocol.McpServer[]
  messages: Message[]
  toolPermissionContext: ToolPermissionContext
  readFileTimestamps: Record<string, number>
  responseState: ToolUseContext['responseState']
  currentModeId: Protocol.SessionModeId
}

export function getProjectDirSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

export function sanitizeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
}

export function getAcpSessionDir(cwd: string): string {
  return join(getKodeBaseDir(), getProjectDirSlug(cwd), 'acp-sessions')
}

export function getAcpSessionFilePath(cwd: string, sessionId: string): string {
  return join(getAcpSessionDir(cwd), `${sanitizeSessionId(sessionId)}.json`)
}

export function buildPersistedAcpSession(
  session: AcpSessionPersistSource,
): PersistedAcpSession {
  return {
    version: ACP_SESSION_STORE_VERSION,
    sessionId: session.sessionId,
    cwd: session.cwd,
    mcpServers: session.mcpServers,
    messages: session.messages,
    toolPermissionContext: session.toolPermissionContext,
    readFileTimestamps: session.readFileTimestamps,
    responseState: session.responseState,
    currentModeId: session.currentModeId,
  }
}

export async function persistAcpSessionToDisk(
  session: AcpSessionPersistSource,
): Promise<void> {
  const startedAt = Date.now()
  const dir = getAcpSessionDir(session.cwd)
  const path = getAcpSessionFilePath(session.cwd, session.sessionId)
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`

  try {
    await mkdir(dir, { recursive: true })
    await writeFile(
      tmpPath,
      JSON.stringify(buildPersistedAcpSession(session), null, 2),
      'utf8',
    )
    await rename(tmpPath, path)
    debug.info('ACP_SESSION_PERSIST_DONE', {
      sessionId: session.sessionId,
      durationMs: Date.now() - startedAt,
    })
  } catch (error) {
    try {
      await rm(tmpPath, { force: true })
    } catch {
      /* no-op */
    }
    debug.warn('ACP_SESSION_PERSIST_FAILED', {
      sessionId: session.sessionId,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    })
    logError(error)
  }
}

export async function loadAcpSessionFromDisk(
  cwd: string,
  sessionId: string,
): Promise<PersistedAcpSession | null> {
  const startedAt = Date.now()

  try {
    const path = getAcpSessionFilePath(cwd, sessionId)
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw) as PersistedAcpSession
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.sessionId !== sessionId) return null
    if (typeof parsed.cwd !== 'string' || parsed.cwd !== cwd) return null
    if (!Array.isArray(parsed.messages)) return null

    debug.info('ACP_SESSION_LOAD_DONE', {
      sessionId,
      durationMs: Date.now() - startedAt,
    })
    return parsed
  } catch {
    return null
  }
}

async function listSessionDirs(cwd?: string): Promise<string[]> {
  if (cwd) return [getAcpSessionDir(cwd)]

  const base = getKodeBaseDir()
  try {
    const entries = await readdir(base, { withFileTypes: true })
    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => join(base, entry.name, 'acp-sessions'))
  } catch {
    return []
  }
}

export async function cleanupExpiredAcpSessions(options?: {
  cwd?: string
  ttlMs?: number
  nowMs?: number
}): Promise<void> {
  const ttlMs = options?.ttlMs ?? ACP_SESSION_TTL_MS
  const nowMs = options?.nowMs ?? Date.now()
  const startedAt = Date.now()
  let deleted = 0

  for (const dir of await listSessionDirs(options?.cwd)) {
    let entries: Array<{ isFile(): boolean; name: string }>
    try {
      entries = (await readdir(dir, {
        withFileTypes: true,
      })) as Array<{ isFile(): boolean; name: string }>
    } catch {
      continue
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const filePath = join(dir, entry.name)
      try {
        const info = await stat(filePath)
        if (nowMs - info.mtimeMs <= ttlMs) continue
        await rm(filePath, { force: true })
        deleted += 1
      } catch {
        /* no-op */
      }
    }
  }

  debug.info('ACP_SESSION_CLEANUP_DONE', {
    deleted,
    durationMs: Date.now() - startedAt,
  })
}
