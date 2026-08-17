import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import pkg from '../../../../package.json'
import { getKodeRoot, resolveDataRoots } from '#config/dataRoots'

import type { JsonlEnvelopeBase, SessionJsonlEntry } from '../sessionJsonl'
import { getKodeAgentSessionId } from './kodeAgentSessionId'
import {
  getKodeAgentSessionForkInfo,
  resetKodeAgentSessionForkInfoForTests,
} from './kodeAgentSessionForkInfo'
import {
  clearSessionSlugCache,
  getOrCreateSessionSlug,
  setSessionSlug,
} from './kodeAgentSessionLog/slug'

type PersistTarget =
  { kind: 'session'; sessionId: string } | { kind: 'agent'; agentId: string }

type PersistableUserMessage = {
  type: 'user'
  uuid: string
  message: unknown
  toolUseResult?: {
    data?: unknown
    metadata?: Record<string, unknown>
  } | null
}

type PersistableAssistantMessage = {
  type: 'assistant'
  uuid: string
  message: unknown
  requestId?: string
  isApiErrorMessage?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isUserMessage(value: unknown): value is PersistableUserMessage {
  if (!isRecord(value)) return false
  if (value.type !== 'user') return false
  if (typeof value.uuid !== 'string' || !value.uuid) return false
  if (!('message' in value)) return false

  const toolUseResult = value.toolUseResult
  if (toolUseResult === undefined || toolUseResult === null) return true
  if (!isRecord(toolUseResult)) return false
  if ('data' in toolUseResult && toolUseResult.data === undefined) return true
  return true
}

function isAssistantMessage(
  value: unknown,
): value is PersistableAssistantMessage {
  if (!isRecord(value)) return false
  if (value.type !== 'assistant') return false
  if (typeof value.uuid !== 'string' || !value.uuid) return false
  if (!('message' in value)) return false
  if (value.requestId !== undefined && typeof value.requestId !== 'string') {
    return false
  }
  if (
    value.isApiErrorMessage !== undefined &&
    typeof value.isApiErrorMessage !== 'boolean'
  ) {
    return false
  }
  return true
}

export function getSessionStoreRoots(): string[] {
  return resolveDataRoots().allRoots
}

function getPrimarySessionStoreRoot(): string {
  return getKodeRoot()
}

export function sanitizeProjectNameForSessionStore(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

function getGitTopLevelBestEffort(cwd: string): string | null {
  try {
    const stdout = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 750,
    })
    const root = stdout.toString('utf8').trim()
    return root || null
  } catch {
    return null
  }
}

export function getSessionStoreProjectNameCandidatesForRead(
  cwd: string,
): string[] {
  const names = new Set<string>()
  names.add(sanitizeProjectNameForSessionStore(cwd))

  const gitTopLevel = getGitTopLevelBestEffort(cwd)
  if (gitTopLevel) {
    names.add(sanitizeProjectNameForSessionStore(gitTopLevel))
  }

  return Array.from(names)
}

export function getSessionProjectsDir(): string {
  return join(getPrimarySessionStoreRoot(), 'projects')
}

export function getSessionProjectDir(cwd: string): string {
  return join(getSessionProjectsDir(), sanitizeProjectNameForSessionStore(cwd))
}

export function getSessionLogFilePath(args: {
  cwd: string
  sessionId: string
}): string {
  return join(getSessionProjectDir(args.cwd), `${args.sessionId}.jsonl`)
}

export function getAgentLogFilePath(args: {
  cwd: string
  sessionId: string
  agentId: string
}): string {
  return join(
    getSessionProjectDir(args.cwd),
    args.sessionId,
    'subagents',
    `agent-${args.agentId}.jsonl`,
  )
}

function safeMkdir(dir: string): void {
  if (existsSync(dir)) return
  mkdirSync(dir, { recursive: true })
}

function safeEnsureFile(path: string): void {
  safeMkdir(dirname(path))
  if (!existsSync(path)) writeFileSync(path, '', 'utf8')
}

function safeAppendJsonl(path: string, record: unknown): void {
  try {
    safeEnsureFile(path)
    appendFileSync(path, JSON.stringify(record) + '\n', 'utf8')
  } catch {
    // Best-effort only: never crash the session on persistence failures.
  }
}

const lastUuidByFile = new Map<string, string | null>()
const snapshotWrittenByFile = new Set<string>()
let currentSessionCustomTitle: string | null = null
let currentSessionTag: string | null = null

type LastPersistedInfo = { uuid: string | null; slug: string | null }

function safeReadLastPersistedInfo(filePath: string): LastPersistedInfo {
  try {
    if (!existsSync(filePath)) return { uuid: null, slug: null }
    const content = readFileSync(filePath, 'utf8')
    const lines = content.split('\n')

    let lastSlug: string | null = null
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim()
      if (!line) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      const record = isRecord(parsed) ? parsed : null
      if (!record) continue

      if (
        !lastSlug &&
        typeof record.slug === 'string' &&
        String(record.slug).trim()
      ) {
        lastSlug = String(record.slug).trim()
      }

      if (typeof record.uuid === 'string' && record.uuid) {
        return { uuid: record.uuid, slug: lastSlug }
      }
    }

    return { uuid: null, slug: lastSlug }
  } catch {
    return { uuid: null, slug: null }
  }
}

type GitBranchCacheEntry = { cwd: string; value: string | undefined }
let gitBranchCache: GitBranchCacheEntry | null = null

function getGitBranchBestEffort(cwd: string): string | undefined {
  if (gitBranchCache && gitBranchCache.cwd === cwd) return gitBranchCache.value

  let value: string | undefined
  try {
    const stdout = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 750,
    })
    const branch = stdout.toString('utf8').trim()
    value = branch || undefined
  } catch {
    value = undefined
  }

  gitBranchCache = { cwd, value }
  return value
}

function ensureFileHistorySnapshot(
  filePath: string,
  firstMessageUuid: string,
): void {
  if (snapshotWrittenByFile.has(filePath)) return

  try {
    safeEnsureFile(filePath)
    const size = statSync(filePath).size
    if (size > 0) {
      snapshotWrittenByFile.add(filePath)
      return
    }
  } catch {
    // Ignore; best-effort.
  }

  const now = new Date().toISOString()
  safeAppendJsonl(filePath, {
    type: 'file-history-snapshot',
    messageId: firstMessageUuid,
    snapshot: {
      messageId: firstMessageUuid,
      trackedFileBackups: {},
      timestamp: now,
    },
    isSnapshotUpdate: false,
  } satisfies SessionJsonlEntry)

  snapshotWrittenByFile.add(filePath)
}

function resolvePersistTarget(toolUseContext: {
  agentId?: string
}): PersistTarget {
  const agentId = toolUseContext.agentId
  if (agentId && agentId !== 'main') return { kind: 'agent', agentId }
  return { kind: 'session', sessionId: getKodeAgentSessionId() }
}

export function appendSessionJsonlFromMessage(args: {
  cwd: string
  message: unknown
  toolUseContext: { agentId?: string }
}): void {
  const { cwd, toolUseContext } = args
  const message = isUserMessage(args.message)
    ? args.message
    : isAssistantMessage(args.message)
      ? args.message
      : null
  if (!message) return

  const userType = (process.env.USER_TYPE ?? 'external').trim() || 'external'
  const sessionId = getKodeAgentSessionId()
  const agentId = (toolUseContext.agentId ?? 'main').trim() || 'main'
  const isSidechain = agentId !== 'main'
  const gitBranch = getGitBranchBestEffort(cwd)
  const forkInfo = getKodeAgentSessionForkInfo()

  const target = resolvePersistTarget(toolUseContext)
  const filePath =
    target.kind === 'agent'
      ? getAgentLogFilePath({ cwd, sessionId, agentId: target.agentId })
      : getSessionLogFilePath({ cwd, sessionId: target.sessionId })

  if (!lastUuidByFile.has(filePath)) {
    const info = safeReadLastPersistedInfo(filePath)
    lastUuidByFile.set(filePath, info.uuid)
    if (info.slug) setSessionSlug(sessionId, info.slug)
  }
  const previousUuid = lastUuidByFile.get(filePath) ?? null

  const slug = getOrCreateSessionSlug(sessionId)

  if (target.kind === 'session') {
    ensureFileHistorySnapshot(filePath, message.uuid)
  }

  const base: JsonlEnvelopeBase = {
    parentUuid: previousUuid,
    logicalParentUuid: undefined,
    isSidechain,
    userType,
    cwd,
    sessionId,
    ...(forkInfo ? { ...forkInfo } : {}),
    version: pkg.version,
    ...(gitBranch ? { gitBranch } : {}),
    agentId,
    slug,
    uuid: message.uuid,
    timestamp: new Date().toISOString(),
  }

  const record: SessionJsonlEntry =
    message.type === 'user'
      ? {
          ...base,
          type: 'user',
          message: message.message,
          ...(message.toolUseResult &&
          isRecord(message.toolUseResult) &&
          'data' in message.toolUseResult &&
          message.toolUseResult.data !== undefined
            ? { toolUseResult: message.toolUseResult.data }
            : {}),
          ...(message.toolUseResult &&
          isRecord(message.toolUseResult) &&
          'metadata' in message.toolUseResult &&
          message.toolUseResult.metadata !== undefined
            ? { toolUseMetadata: message.toolUseResult.metadata }
            : {}),
        }
      : {
          ...base,
          type: 'assistant',
          message: message.message,
          ...(typeof message.requestId === 'string' && message.requestId
            ? { requestId: message.requestId }
            : {}),
          ...(message.isApiErrorMessage ? { isApiErrorMessage: true } : {}),
        }

  safeAppendJsonl(filePath, record)
  lastUuidByFile.set(filePath, message.uuid)
}

export function appendSessionSummaryRecord(args: {
  cwd: string
  summary: string
  leafUuid: string
  sessionId?: string
}): void {
  const sessionId = args.sessionId ?? getKodeAgentSessionId()
  safeAppendJsonl(getSessionLogFilePath({ cwd: args.cwd, sessionId }), {
    type: 'summary',
    summary: args.summary,
    leafUuid: args.leafUuid,
  } satisfies SessionJsonlEntry)
}

export function appendSessionCustomTitleRecord(args: {
  cwd: string
  sessionId: string
  customTitle: string | null
}): void {
  safeAppendJsonl(
    getSessionLogFilePath({ cwd: args.cwd, sessionId: args.sessionId }),
    {
      type: 'custom-title',
      sessionId: args.sessionId,
      customTitle: args.customTitle,
    } satisfies SessionJsonlEntry,
  )
  if (args.sessionId === getKodeAgentSessionId()) {
    currentSessionCustomTitle = args.customTitle
  }
}

export function appendSessionTagRecord(args: {
  cwd: string
  sessionId: string
  tag: string | null
}): void {
  safeAppendJsonl(
    getSessionLogFilePath({ cwd: args.cwd, sessionId: args.sessionId }),
    {
      type: 'tag',
      sessionId: args.sessionId,
      tag: args.tag,
    } satisfies SessionJsonlEntry,
  )
  if (args.sessionId === getKodeAgentSessionId()) {
    currentSessionTag = args.tag
  }
}

export function appendSessionSessionSummaryRecord(args: {
  cwd: string
  sessionId: string
  summary: string | null
}): void {
  safeAppendJsonl(
    getSessionLogFilePath({ cwd: args.cwd, sessionId: args.sessionId }),
    {
      type: 'session-summary',
      sessionId: args.sessionId,
      summary: args.summary,
    } satisfies SessionJsonlEntry,
  )
}

export function getCurrentSessionCustomTitle(): string | null {
  return currentSessionCustomTitle
}

export function getCurrentSessionTag(): string | null {
  return currentSessionTag
}

export function resetSessionJsonlStateForTests(): void {
  lastUuidByFile.clear()
  snapshotWrittenByFile.clear()
  clearSessionSlugCache()
  resetKodeAgentSessionForkInfoForTests()
  gitBranchCache = null
  currentSessionCustomTitle = null
  currentSessionTag = null
}
