import { resolve } from 'node:path'
import { existsSync } from 'node:fs'

import { loadToolPermissionContextFromDisk } from '@kode/core/utils/permissions/toolPermissionSettings'
import { getSessionLogFilePath } from '#protocol/utils/kodeAgentSessionLog'

import {
  buildSessionList,
  loadSessionMessages,
} from './handlers/session.handler'
import { readSessionMetadata } from './sessionMetadataStore'
import { denyAllPermissionRequests } from './ws/permissionRequests'
import type { DaemonSession } from './ws/types'

export type SessionLookupResult =
  | { ok: true; session: DaemonSession; restored: boolean }
  | {
      ok: false
      reason: 'not_found' | 'cwd_mismatch' | 'archived' | 'metadata_invalid'
    }

export const DEFAULT_MAX_IDLE_SESSIONS = 100
export const DEFAULT_RESTORED_TURN_DEDUP_LIMIT = 512

function createRestoredTurnIndex(
  messages: DaemonSession['messages'],
): DaemonSession['turnsByClientMessageUuid'] {
  const turns: DaemonSession['turnsByClientMessageUuid'] = new Map()
  const restoredUserMessages = messages.filter(
    message => message.type === 'user',
  )
  for (const message of restoredUserMessages.slice(
    -DEFAULT_RESTORED_TURN_DEDUP_LIMIT,
  )) {
    turns.set(message.uuid, {
      turnId: crypto.randomUUID(),
      clientMessageUuid: message.uuid,
      state: 'completed',
      terminalEvent: null,
    })
  }
  return turns
}

function isIdleSession(session: DaemonSession): boolean {
  return (
    session.clients.size === 0 &&
    session.turnInFlight === false &&
    session.activeAbortController === null &&
    session.inflightPermissionRequests.size === 0
  )
}

function isDurableSessionInWorkspace(args: {
  cwd: string
  sessionId: string
  sessionCwd: string | null
}): boolean {
  if (typeof args.sessionCwd === 'string') {
    return resolve(args.sessionCwd) === args.cwd
  }
  // Old JSONL records did not always carry `cwd`. Only accept those from the
  // current canonical project directory, never from a git-root fallback.
  return existsSync(
    getSessionLogFilePath({ cwd: args.cwd, sessionId: args.sessionId }),
  )
}

export function createDaemonSession(args: {
  cwd: string
  sessionId?: string
  messages?: DaemonSession['messages']
  createdAt?: string
  updatedAt?: string
  forkedFromSessionId?: string | null
  forkRootSessionId?: string | null
}): DaemonSession {
  const cwd = resolve(args.cwd)
  const messages = args.messages ?? []
  const now = new Date().toISOString()
  return {
    sessionId: args.sessionId ?? crypto.randomUUID(),
    cwd,
    createdAt: args.createdAt ?? now,
    updatedAt: args.updatedAt ?? now,
    forkedFromSessionId: args.forkedFromSessionId ?? null,
    forkRootSessionId: args.forkRootSessionId ?? null,
    clients: new Set(),
    messages,
    readFileTimestamps: {},
    responseState: {},
    toolPermissionContext: loadToolPermissionContextFromDisk({
      projectDir: cwd,
      includeKodeProjectConfig: true,
      isBypassPermissionsModeAvailable: true,
    }),
    activeAbortController: null,
    turnInFlight: false,
    inflightPermissionRequests: new Map(),
    nextSequence: 1,
    eventJournal: [],
    turnsByClientMessageUuid: createRestoredTurnIndex(messages),
  }
}

export class SessionRegistry {
  private readonly maxIdleSessions: number

  constructor(
    private readonly sessions: Map<string, DaemonSession> = new Map(),
    options: { maxIdleSessions?: number } = {},
  ) {
    const configured = options.maxIdleSessions ?? DEFAULT_MAX_IDLE_SESSIONS
    this.maxIdleSessions = Number.isFinite(configured)
      ? Math.max(1, Math.floor(configured))
      : DEFAULT_MAX_IDLE_SESSIONS
  }

  get size(): number {
    return this.sessions.size
  }

  get(sessionId: string): DaemonSession | null {
    return this.sessions.get(sessionId) ?? null
  }

  listForCwd(cwd: string): DaemonSession[] {
    const canonicalCwd = resolve(cwd)
    return Array.from(this.sessions.values()).filter(
      session => resolve(session.cwd) === canonicalCwd,
    )
  }

  create(cwd: string): DaemonSession {
    const session = createDaemonSession({ cwd })
    this.sessions.set(session.sessionId, session)
    this.evictIdleSessions({ preserve: session })
    return session
  }

  createFromMessages(args: {
    cwd: string
    sessionId: string
    messages: DaemonSession['messages']
    createdAt?: string
    updatedAt?: string
    forkedFromSessionId?: string | null
    forkRootSessionId?: string | null
  }): DaemonSession {
    const existing = this.sessions.get(args.sessionId)
    if (existing) {
      if (resolve(existing.cwd) !== resolve(args.cwd)) {
        throw new Error('Session workspace mismatch')
      }
      return existing
    }
    const session = createDaemonSession(args)
    this.sessions.set(session.sessionId, session)
    this.evictIdleSessions({ preserve: session })
    return session
  }

  deleteIfIdle(session: DaemonSession): boolean {
    if (this.sessions.get(session.sessionId) !== session) return false
    if (!isIdleSession(session)) return false
    return this.sessions.delete(session.sessionId)
  }

  evictIdleSessions(options: { preserve?: DaemonSession } = {}): number {
    let idleCount = 0
    for (const session of this.sessions.values()) {
      if (isIdleSession(session)) idleCount += 1
    }
    if (idleCount <= this.maxIdleSessions) return 0

    let evicted = 0
    for (const [sessionId, session] of this.sessions) {
      if (idleCount <= this.maxIdleSessions) break
      if (session === options.preserve || !isIdleSession(session)) continue
      this.sessions.delete(sessionId)
      idleCount -= 1
      evicted += 1
    }
    return evicted
  }

  cancelActiveWork(message: string): void {
    for (const session of this.sessions.values()) {
      try {
        session.activeAbortController?.abort()
      } catch {
        /* no-op */
      }
      denyAllPermissionRequests(session, message)
    }
  }

  getOrLoad(args: { cwd: string; sessionId: string }): SessionLookupResult {
    const cwd = resolve(args.cwd)
    const metadata = readSessionMetadata({ cwd, sessionId: args.sessionId })
    if (metadata.kind === 'invalid') {
      return { ok: false, reason: 'metadata_invalid' }
    }
    if (metadata.kind === 'ok' && metadata.metadata.archivedAt) {
      return { ok: false, reason: 'archived' }
    }
    const active = this.sessions.get(args.sessionId)
    if (active) {
      if (resolve(active.cwd) !== cwd) {
        return { ok: false, reason: 'cwd_mismatch' }
      }
      return { ok: true, session: active, restored: false }
    }

    const durable = buildSessionList({ cwd }).find(
      session =>
        session.sessionId === args.sessionId &&
        isDurableSessionInWorkspace({
          cwd,
          sessionId: args.sessionId,
          sessionCwd: session.cwd,
        }),
    )
    if (!durable) return { ok: false, reason: 'not_found' }

    try {
      const messages = loadSessionMessages({ cwd, sessionId: args.sessionId })
      const session = createDaemonSession({
        cwd,
        sessionId: args.sessionId,
        messages,
        createdAt:
          metadata.kind === 'ok' ? metadata.metadata.createdAt : undefined,
        updatedAt:
          metadata.kind === 'ok' ? metadata.metadata.updatedAt : undefined,
        forkedFromSessionId:
          metadata.kind === 'ok'
            ? metadata.metadata.forkedFromSessionId
            : (durable.forkedFromSessionId ?? null),
        forkRootSessionId:
          metadata.kind === 'ok'
            ? metadata.metadata.forkRootSessionId
            : (durable.forkRootSessionId ?? null),
      })
      this.sessions.set(session.sessionId, session)
      this.evictIdleSessions({ preserve: session })
      return { ok: true, session, restored: true }
    } catch {
      return { ok: false, reason: 'not_found' }
    }
  }
}
