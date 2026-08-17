import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import type { Session } from '@kode/protocol'
import type { Message } from '@kode/core/query'
import { isUuid } from '@kode/runtime'
import {
  appendSessionCustomTitleRecord,
  appendSessionSessionSummaryRecord,
  appendSessionTagRecord,
  getSessionLogFilePath,
} from '#protocol/utils/kodeAgentSessionLog'
import { getOrCreateSessionSlug } from '#protocol/utils/kodeAgentSessionLog/slug'

import { buildSessionList } from './handlers/session.handler'
import {
  getSessionMetadataFilePath,
  readSessionMetadata,
  SessionMetadataValidationError,
  writeSessionMetadata,
  type PersistentSessionMetadata,
} from './sessionMetadataStore'
import { SessionRegistry } from './sessionRegistry'
import type { DaemonSession } from './ws/types'

export type PersistentSessionFailure =
  | 'not_found'
  | 'cwd_mismatch'
  | 'archived'
  | 'metadata_invalid'
  | 'active'
  | 'already_exists'
  | 'invalid_cutoff'
  | 'invalid_metadata'
  | 'persistence_failed'

export type PersistentSessionDetail = {
  session: Session
  messages: Message[]
  runtime: DaemonSession | null
}

export type PersistentSessionResult =
  | { ok: true; detail: PersistentSessionDetail }
  | { ok: false; reason: PersistentSessionFailure }

type ForkArgs = {
  cwd: string
  sessionId: string
  newSessionId?: string
  beforeUuid?: string | null
  includeUuid?: boolean
  customTitle?: string | null
  tag?: string | null
  summary?: string | null
}

type MetadataPatch = {
  customTitle?: string | null
  tag?: string | null
  summary?: string | null
  archived?: boolean
}

function isSameCwd(left: string, right: string): boolean {
  return resolve(left) === resolve(right)
}

function belongsToWorkspace(session: Session, cwd: string): boolean {
  if (typeof session.cwd === 'string') return isSameCwd(session.cwd, cwd)
  // Legacy JSONL without a `cwd` is accepted only when it lives in this exact
  // workspace's primary store, which prevents git-root/worktree bleed-through.
  return existsSync(
    getSessionLogFilePath({ cwd, sessionId: session.sessionId }),
  )
}

function asPersistableMessage(
  message: Message,
): Extract<Message, { type: 'user' | 'assistant' }> | null {
  return message.type === 'user' || message.type === 'assistant'
    ? message
    : null
}

function isToolResultMessage(message: Message): boolean {
  if (message.type !== 'user') return false
  const content = message.message.content
  return (
    Array.isArray(content) &&
    content.some(
      block =>
        Boolean(block) &&
        typeof block === 'object' &&
        !Array.isArray(block) &&
        (block as { type?: unknown }).type === 'tool_result',
    )
  )
}

function hasActiveRuntimeState(session: DaemonSession): boolean {
  return (
    session.turnInFlight ||
    session.clients.size > 0 ||
    session.activeAbortController !== null ||
    session.inflightPermissionRequests.size > 0
  )
}

function metadataForSession(args: {
  session: Session
  metadata: PersistentSessionMetadata | null
  runtime: DaemonSession | null
}): Session {
  const { session, metadata, runtime } = args
  return {
    ...session,
    customTitle: metadata ? metadata.customTitle : session.customTitle,
    tag: metadata ? metadata.tag : session.tag,
    summary: metadata ? metadata.summary : session.summary,
    forkedFromSessionId: metadata
      ? metadata.forkedFromSessionId
      : (session.forkedFromSessionId ?? runtime?.forkedFromSessionId ?? null),
    forkRootSessionId: metadata
      ? metadata.forkRootSessionId
      : (session.forkRootSessionId ?? runtime?.forkRootSessionId ?? null),
    archivedAt: metadata?.archivedAt ?? null,
    createdAt:
      metadata?.createdAt ?? session.createdAt ?? runtime?.createdAt ?? null,
    modifiedAt:
      metadata?.updatedAt ?? session.modifiedAt ?? runtime?.updatedAt ?? null,
  }
}

function makeRuntimeSession(args: {
  runtime: DaemonSession
  metadata: PersistentSessionMetadata | null
  disk: Session | null
}): Session {
  const { runtime, metadata, disk } = args
  return metadataForSession({
    session: disk ?? {
      sessionId: runtime.sessionId,
      slug: null,
      customTitle: null,
      tag: null,
      summary: null,
      cwd: runtime.cwd,
      createdAt: runtime.createdAt,
      modifiedAt: runtime.updatedAt,
    },
    metadata,
    runtime,
  })
}

function writeForkTranscript(args: {
  cwd: string
  sessionId: string
  messages: Message[]
  forkedFromSessionId: string
  forkRootSessionId: string
}): void {
  const path = getSessionLogFilePath({
    cwd: args.cwd,
    sessionId: args.sessionId,
  })
  if (existsSync(path)) throw new Error('Target session already exists')

  const now = new Date().toISOString()
  const slug = getOrCreateSessionSlug(args.sessionId)
  let parentUuid: string | null = null
  const records: Record<string, unknown>[] = []

  for (const original of args.messages) {
    const message = asPersistableMessage(original)
    if (!message || !isUuid(message.uuid)) continue

    const base = {
      cwd: args.cwd,
      sessionId: args.sessionId,
      forkedFromSessionId: args.forkedFromSessionId,
      forkRootSessionId: args.forkRootSessionId,
      version: process.env.npm_package_version ?? 'unknown',
      userType: (process.env.USER_TYPE ?? 'external').trim() || 'external',
      isSidechain: false,
      parentUuid,
      agentId: 'main',
      slug,
      uuid: message.uuid,
      timestamp: now,
    }

    if (message.type === 'user') {
      const toolUseResult = message.toolUseResult
      records.push({
        ...base,
        type: 'user',
        message: message.message,
        ...(toolUseResult &&
        typeof toolUseResult === 'object' &&
        'data' in toolUseResult
          ? { toolUseResult: toolUseResult.data }
          : {}),
      })
    } else {
      records.push({
        ...base,
        type: 'assistant',
        message: message.message,
        ...(message.requestId ? { requestId: message.requestId } : {}),
        ...(message.isApiErrorMessage ? { isApiErrorMessage: true } : {}),
      })
    }
    parentUuid = message.uuid
  }

  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporaryPath = join(
    directory,
    `.${args.sessionId}.${process.pid}.${randomUUID()}.tmp`,
  )
  try {
    writeFileSync(
      temporaryPath,
      records.map(record => JSON.stringify(record)).join('\n') + '\n',
      { encoding: 'utf8', mode: 0o600 },
    )
    renameSync(temporaryPath, path)
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true })
    } catch {
      /* no-op */
    }
    throw error
  }
}

export class PersistentSessionService {
  constructor(private readonly sessionRegistry: SessionRegistry) {}

  list(args: { cwd: string; includeArchived?: boolean }): Session[] {
    const cwd = resolve(args.cwd)
    const diskById = new Map(
      buildSessionList({ cwd })
        .filter(session => belongsToWorkspace(session, cwd))
        .map(session => [session.sessionId, session]),
    )
    const merged = new Map<string, Session>()

    for (const disk of diskById.values()) {
      const metadataResult = readSessionMetadata({
        cwd,
        sessionId: disk.sessionId,
      })
      if (metadataResult.kind === 'invalid') continue
      const metadata =
        metadataResult.kind === 'ok' ? metadataResult.metadata : null
      const candidateRuntime = this.sessionRegistry.get(disk.sessionId)
      const runtime =
        candidateRuntime && isSameCwd(candidateRuntime.cwd, cwd)
          ? candidateRuntime
          : null
      const session = metadataForSession({ session: disk, metadata, runtime })
      if (!args.includeArchived && session.archivedAt) continue
      merged.set(session.sessionId, session)
    }

    for (const runtime of this.sessionRegistry.listForCwd(cwd)) {
      const metadataResult = readSessionMetadata({
        cwd,
        sessionId: runtime.sessionId,
      })
      if (metadataResult.kind === 'invalid') continue
      const metadata =
        metadataResult.kind === 'ok' ? metadataResult.metadata : null
      const session = makeRuntimeSession({
        runtime,
        metadata,
        disk: diskById.get(runtime.sessionId) ?? null,
      })
      if (!args.includeArchived && session.archivedAt) continue
      merged.set(session.sessionId, session)
    }

    return Array.from(merged.values()).sort((left, right) => {
      const leftTime = left.modifiedAt ? Date.parse(left.modifiedAt) : 0
      const rightTime = right.modifiedAt ? Date.parse(right.modifiedAt) : 0
      return rightTime - leftTime
    })
  }

  resolve(args: {
    cwd: string
    sessionId: string
    includeArchived?: boolean
  }): PersistentSessionResult {
    const cwd = resolve(args.cwd)
    const metadataResult = readSessionMetadata({
      cwd,
      sessionId: args.sessionId,
    })
    if (metadataResult.kind === 'invalid') {
      return { ok: false, reason: 'metadata_invalid' }
    }
    const metadata =
      metadataResult.kind === 'ok' ? metadataResult.metadata : null
    if (metadata?.archivedAt && !args.includeArchived) {
      return { ok: false, reason: 'archived' }
    }

    const active = this.sessionRegistry.get(args.sessionId)
    if (active) {
      if (!isSameCwd(active.cwd, cwd)) {
        return { ok: false, reason: 'cwd_mismatch' }
      }
      const disk = buildSessionList({ cwd }).find(
        session =>
          session.sessionId === args.sessionId &&
          belongsToWorkspace(session, cwd),
      )
      return {
        ok: true,
        detail: {
          session: makeRuntimeSession({
            runtime: active,
            metadata,
            disk: disk ?? null,
          }),
          messages: active.messages,
          runtime: active,
        },
      }
    }

    if (metadata?.archivedAt && args.includeArchived) {
      return {
        ok: true,
        detail: {
          session: {
            sessionId: args.sessionId,
            slug: null,
            customTitle: metadata.customTitle,
            tag: metadata.tag,
            summary: metadata.summary,
            cwd,
            createdAt: metadata.createdAt,
            modifiedAt: metadata.updatedAt,
            forkedFromSessionId: metadata.forkedFromSessionId,
            forkRootSessionId: metadata.forkRootSessionId,
            archivedAt: metadata.archivedAt,
          },
          messages: [],
          runtime: null,
        },
      }
    }

    const found = this.sessionRegistry.getOrLoad({
      cwd,
      sessionId: args.sessionId,
    })
    if (found.ok === false) return found
    const disk = buildSessionList({ cwd }).find(
      session =>
        session.sessionId === args.sessionId &&
        belongsToWorkspace(session, cwd),
    )
    if (!disk) return { ok: false, reason: 'not_found' }
    return {
      ok: true,
      detail: {
        session: makeRuntimeSession({
          runtime: found.session,
          metadata,
          disk,
        }),
        messages: found.session.messages,
        runtime: found.session,
      },
    }
  }

  updateMetadata(args: {
    cwd: string
    sessionId: string
    patch: MetadataPatch
  }): PersistentSessionResult {
    const current = this.resolve({
      cwd: args.cwd,
      sessionId: args.sessionId,
      includeArchived: true,
    })
    if (current.ok === false) return current

    const session = current.detail.session
    const runtime = current.detail.runtime
    if (
      args.patch.archived === true &&
      runtime &&
      hasActiveRuntimeState(runtime)
    ) {
      return { ok: false, reason: 'active' }
    }
    const archivedAt =
      args.patch.archived === undefined
        ? undefined
        : args.patch.archived
          ? (session.archivedAt ?? new Date().toISOString())
          : null
    try {
      const metadata = writeSessionMetadata({
        cwd: args.cwd,
        sessionId: args.sessionId,
        patch: {
          customTitle: args.patch.customTitle,
          tag: args.patch.tag,
          summary: args.patch.summary,
          archivedAt,
          forkedFromSessionId: session.forkedFromSessionId,
          forkRootSessionId: session.forkRootSessionId,
        },
        defaults: {
          customTitle: session.customTitle,
          tag: session.tag,
          summary: session.summary,
          forkedFromSessionId: session.forkedFromSessionId,
          forkRootSessionId: session.forkRootSessionId,
        },
      })
      if (args.patch.customTitle !== undefined) {
        appendSessionCustomTitleRecord({
          cwd: args.cwd,
          sessionId: args.sessionId,
          customTitle: metadata.customTitle,
        })
      }
      if (args.patch.tag !== undefined) {
        appendSessionTagRecord({
          cwd: args.cwd,
          sessionId: args.sessionId,
          tag: metadata.tag,
        })
      }
      if (args.patch.summary !== undefined) {
        appendSessionSessionSummaryRecord({
          cwd: args.cwd,
          sessionId: args.sessionId,
          summary: metadata.summary,
        })
      }

      if (runtime) runtime.updatedAt = metadata.updatedAt
      const resolved = this.resolve({
        cwd: args.cwd,
        sessionId: args.sessionId,
        includeArchived: true,
      })
      if (args.patch.archived === true && runtime) {
        this.sessionRegistry.deleteIfIdle(runtime)
      }
      return resolved
    } catch (error) {
      return {
        ok: false,
        reason:
          error instanceof SessionMetadataValidationError
            ? 'invalid_metadata'
            : 'persistence_failed',
      }
    }
  }

  fork(args: ForkArgs): PersistentSessionResult {
    const source = this.resolve({
      cwd: args.cwd,
      sessionId: args.sessionId,
    })
    if (source.ok === false) return source
    if (source.detail.runtime?.turnInFlight) {
      return { ok: false, reason: 'active' }
    }

    const sessionId = args.newSessionId?.trim() || crypto.randomUUID()
    if (!isUuid(sessionId) || sessionId === args.sessionId) {
      return { ok: false, reason: 'already_exists' }
    }
    if (
      this.sessionRegistry.get(sessionId) ||
      buildSessionList({ cwd: args.cwd }).some(
        session =>
          session.sessionId === sessionId &&
          belongsToWorkspace(session, resolve(args.cwd)),
      ) ||
      readSessionMetadata({ cwd: args.cwd, sessionId }).kind !== 'missing'
    ) {
      return { ok: false, reason: 'already_exists' }
    }

    const sourceMessages = source.detail.messages
      .map(asPersistableMessage)
      .filter((message): message is NonNullable<typeof message> =>
        Boolean(message),
      )
    const beforeUuid = args.beforeUuid?.trim() ?? ''
    let copiedMessages = sourceMessages
    if (beforeUuid) {
      const index = sourceMessages.findIndex(
        message => message.uuid === beforeUuid,
      )
      if (index === -1) return { ok: false, reason: 'invalid_cutoff' }
      copiedMessages = sourceMessages.slice(
        0,
        args.includeUuid === false ? index : index + 1,
      )
      // A cut at an assistant tool-use must retain its immediate tool results;
      // otherwise the durable child cannot resume with a coherent transcript.
      if (
        args.includeUuid !== false &&
        sourceMessages[index]?.type === 'assistant'
      ) {
        for (const following of sourceMessages.slice(index + 1)) {
          if (!isToolResultMessage(following)) break
          copiedMessages.push(following)
        }
      }
    }

    const forkRootSessionId =
      source.detail.session.forkRootSessionId ?? source.detail.session.sessionId
    let wroteTranscript = false
    try {
      writeForkTranscript({
        cwd: args.cwd,
        sessionId,
        messages: copiedMessages,
        forkedFromSessionId: args.sessionId,
        forkRootSessionId,
      })
      wroteTranscript = true
      const metadata = writeSessionMetadata({
        cwd: args.cwd,
        sessionId,
        patch: {
          customTitle:
            args.customTitle === undefined
              ? source.detail.session.customTitle
              : args.customTitle,
          tag: args.tag === undefined ? source.detail.session.tag : args.tag,
          summary:
            args.summary === undefined
              ? source.detail.session.summary
              : args.summary,
          forkedFromSessionId: args.sessionId,
          forkRootSessionId,
        },
        defaults: {
          customTitle: source.detail.session.customTitle,
          tag: source.detail.session.tag,
          summary: source.detail.session.summary,
          forkedFromSessionId: args.sessionId,
          forkRootSessionId,
        },
      })
      appendSessionCustomTitleRecord({
        cwd: args.cwd,
        sessionId,
        customTitle: metadata.customTitle,
      })
      appendSessionTagRecord({ cwd: args.cwd, sessionId, tag: metadata.tag })
      appendSessionSessionSummaryRecord({
        cwd: args.cwd,
        sessionId,
        summary: metadata.summary,
      })
      this.sessionRegistry.createFromMessages({
        cwd: args.cwd,
        sessionId,
        messages: copiedMessages,
        createdAt: metadata.createdAt,
        updatedAt: metadata.updatedAt,
        forkedFromSessionId: args.sessionId,
        forkRootSessionId,
      })
    } catch (error) {
      if (wroteTranscript) {
        try {
          rmSync(getSessionLogFilePath({ cwd: args.cwd, sessionId }), {
            force: true,
          })
        } catch {
          /* no-op */
        }
        try {
          rmSync(getSessionMetadataFilePath({ cwd: args.cwd, sessionId }), {
            force: true,
          })
        } catch {
          /* no-op */
        }
      }
      return {
        ok: false,
        reason:
          error instanceof SessionMetadataValidationError
            ? 'invalid_metadata'
            : 'persistence_failed',
      }
    }

    return this.resolve({ cwd: args.cwd, sessionId })
  }

  archive(args: { cwd: string; sessionId: string }): PersistentSessionResult {
    const current = this.resolve({
      cwd: args.cwd,
      sessionId: args.sessionId,
      includeArchived: true,
    })
    if (current.ok === false) {
      // DELETE is deliberately idempotent for a session that is already gone.
      return current.reason === 'not_found'
        ? { ok: false, reason: 'not_found' }
        : current
    }

    const runtime = current.detail.runtime
    if (current.detail.session.archivedAt) return current
    if (runtime && hasActiveRuntimeState(runtime)) {
      return { ok: false, reason: 'active' }
    }

    const updated = this.updateMetadata({
      cwd: args.cwd,
      sessionId: args.sessionId,
      patch: { archived: true },
    })
    if (updated.ok === false) return updated
    return updated
  }
}
