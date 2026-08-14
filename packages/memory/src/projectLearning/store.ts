import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { getKodeRoot } from '#config/dataRoots'
import { appendJsonlAsync, flushPendingSync } from '#core/utils/jsonlWriter'
import { getProjectScope } from '#core/projectScope'
import {
  isSensitiveOnlyMemory,
  redactSensitiveMemoryText,
} from '#core/memory/redaction'

import {
  PROJECT_LEARNING_SCHEMA_VERSION,
  type CaptureProjectContextSnapshotInput,
  type ObserveProjectLearningInput,
  type ProjectContextSnapshot,
  type ProjectLearningCandidate,
  type ProjectLearningEvent,
  type ProjectLearningEvidence,
  type ProjectLearningListInput,
  type ProjectLearningRecord,
  type ProjectLearningScope,
  type ProjectWorkspaceRevision,
  type RetireProjectLearningInput,
} from './types'

const EVENTS_FILENAME = 'learning.jsonl'
const SNAPSHOTS_FILENAME = 'context-snapshots.jsonl'
const SCOPE_FILENAME = 'scope.json'
const LOCK_FILENAME = '.lock'
const LOCK_STALE_MS = 10_000
const LOCK_RETRIES = 5
const LOCK_RETRY_DELAY_MS = 25
const MAX_LEARNING_TEXT_LENGTH = 600
const MAX_SNAPSHOT_SUMMARY_LENGTH = 24_000
const MAX_EVIDENCE = 12
const MAX_PATH_PREFIXES = 8
const SNAPSHOT_LOG_COMPACT_MAX_ENTRIES = 200
// Compacting rewrites the whole log, so the threshold must be low enough that
// the rewrite stays cheap yet high enough that it does not run constantly.
let EVENT_LOG_COMPACT_MAX_BYTES = 512 * 1024
const SNAPSHOT_LOG_COMPACT_MAX_BYTES = 2 * 1024 * 1024

type CachedEvents = {
  size: number
  mtimeMs: number
  events: ProjectLearningEvent[]
}

const eventsCache = new Map<string, CachedEvents>()
let testStorageRoot: string | undefined

const UNSAFE_AUTOMATIC_DIRECTIVE =
  /\b(?:ignore|bypass|disable|override|skip)\b[\s\S]{0,160}\b(?:permission|approval|system|instruction|policy|safety)\b|\b(?:run|execute)\b[\s\S]{0,120}\bwithout\s+(?:asking|approval|permission)\b/iu

function sleepSync(ms: number): void {
  if (ms <= 0) return
  const view = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(view, 0, 0, ms)
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // The primary operation remains authoritative.
  }
}

function acquireLock(lockPath: string): (() => void) | null {
  const lockToken = `${process.pid} ${randomUUID()} ${Date.now()}\n`
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    try {
      writeFileSync(lockPath, lockToken, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      })
      return () => {
        // Only remove the lock if it is still ours. If a competing process
        // declared our lock stale and took over while we were still working,
        // unlinking unconditionally would release THEIR lock and let a third
        // writer enter the critical section concurrently.
        try {
          if (readFileSync(lockPath, 'utf8') === lockToken) {
            safeUnlink(lockPath)
          }
        } catch {
          // The lock was already removed by a competitor or owner.
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST') {
        return null
      }
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          safeUnlink(lockPath)
        }
      } catch {
        // The competing writer may have completed while we inspected its lock.
      }
      sleepSync(LOCK_RETRY_DELAY_MS)
    }
  }
  return null
}

function cleanText(
  value: unknown,
  maxLength = MAX_LEARNING_TEXT_LENGTH,
): string {
  return String(value ?? '')
    .replace(/\u0000/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

function cleanSummary(value: unknown): string {
  return String(value ?? '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, MAX_SNAPSHOT_SUMMARY_LENGTH)
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function asFiniteTime(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function cleanId(value: unknown, maxLength: number = 160): string | null {
  const clean = cleanText(value, maxLength)
  return clean || null
}

function cleanPathPrefixes(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const prefixes = new Set<string>()
  for (const raw of value) {
    const candidate = cleanText(raw, 240).replace(/\\/g, '/')
    if (!candidate || candidate.startsWith('/') || candidate.includes('\0')) {
      continue
    }
    const normalized = candidate.replace(/^\.\//, '').replace(/\/+$/, '')
    if (
      !normalized ||
      normalized === '..' ||
      normalized.startsWith('../') ||
      normalized.split('/').some(part => part === '..')
    ) {
      continue
    }
    prefixes.add(normalized)
    if (prefixes.size >= MAX_PATH_PREFIXES) break
  }
  return [...prefixes]
}

function parseWorkspace(value: unknown): ProjectWorkspaceRevision {
  if (!isRecord(value)) return {}
  const gitHead = cleanId(value.gitHead, 128) ?? undefined
  const gitBranchValue = value.gitBranch
  const gitBranch =
    gitBranchValue === null ? null : (cleanId(gitBranchValue, 240) ?? undefined)
  const workspaceFingerprint =
    cleanId(value.workspaceFingerprint, 128) ?? undefined
  return {
    ...(gitHead ? { gitHead } : {}),
    ...(gitBranch === null || gitBranch ? { gitBranch } : {}),
    ...(workspaceFingerprint ? { workspaceFingerprint } : {}),
  }
}

function parseEvidence(value: unknown): ProjectLearningEvidence | null {
  if (!isRecord(value)) return null
  const sourceId = cleanId(value.sourceId)
  const sessionId = cleanId(value.sessionId)
  const observedAt = asFiniteTime(value.observedAt)
  if (!sourceId || !sessionId || observedAt === undefined) return null
  return {
    sourceId,
    sessionId,
    observedAt,
    workspace: parseWorkspace(value.workspace),
  }
}

function parseKind(value: unknown): ProjectLearningRecord['kind'] | null {
  return value === 'procedure' || value === 'decision' || value === 'failure'
    ? value
    : null
}

function parseStatus(value: unknown): ProjectLearningRecord['status'] | null {
  return value === 'candidate' || value === 'active' || value === 'retired'
    ? value
    : null
}

function parseLearning(value: unknown): ProjectLearningRecord | null {
  if (!isRecord(value)) return null
  const id = cleanId(value.id)
  const scopeId = cleanId(value.scopeId, 100)
  const text = cleanText(value.text)
  const kind = parseKind(value.kind)
  const status = parseStatus(value.status)
  const createdAt = asFiniteTime(value.createdAt)
  const updatedAt = asFiniteTime(value.updatedAt)
  if (
    !id ||
    !scopeId ||
    !text ||
    !kind ||
    !status ||
    !createdAt ||
    !updatedAt
  ) {
    return null
  }
  const sanitized = redactSensitiveMemoryText(text).text
  if (!sanitized || isSensitiveOnlyMemory(sanitized)) return null
  const normalizedText = normalizeText(sanitized)
  const rawEvidence = Array.isArray(value.evidence) ? value.evidence : []
  const evidence = rawEvidence
    .map(parseEvidence)
    .filter((item): item is ProjectLearningEvidence => item !== null)
    .slice(0, MAX_EVIDENCE)
  const confidenceRaw = value.confidence
  const confidence =
    typeof confidenceRaw === 'number' && Number.isFinite(confidenceRaw)
      ? Math.max(0, Math.min(1, confidenceRaw))
      : 0.4
  const retiredAt = asFiniteTime(value.retiredAt)
  const retirementReason = cleanText(value.retirementReason, 320) || undefined
  return {
    id,
    scopeId,
    text: sanitized,
    normalizedText,
    fingerprint: fingerprint(normalizedText),
    kind,
    status,
    confidence,
    pathPrefixes: cleanPathPrefixes(value.pathPrefixes),
    evidence,
    createdAt,
    updatedAt,
    ...(retiredAt ? { retiredAt } : {}),
    ...(retirementReason ? { retirementReason } : {}),
  }
}

function parseEvent(value: unknown): ProjectLearningEvent | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== PROJECT_LEARNING_SCHEMA_VERSION
  ) {
    return null
  }
  const at = asFiniteTime(value.at)
  if (at === undefined) return null
  if (value.type === 'upsert') {
    const learning = parseLearning(value.learning)
    return learning
      ? {
          schemaVersion: PROJECT_LEARNING_SCHEMA_VERSION,
          type: 'upsert',
          at,
          learning,
        }
      : null
  }
  if (value.type === 'retire') {
    const id = cleanId(value.id)
    const reason = cleanText(value.reason, 320) || undefined
    return id
      ? {
          schemaVersion: PROJECT_LEARNING_SCHEMA_VERSION,
          type: 'retire',
          at,
          id,
          ...(reason ? { reason } : {}),
        }
      : null
  }
  return null
}

function readEvents(path: string): ProjectLearningEvent[] {
  flushPendingSync(path)
  if (!existsSync(path)) return []
  try {
    const stats = statSync(path)
    const cached = eventsCache.get(path)
    if (
      cached &&
      cached.size === stats.size &&
      cached.mtimeMs === stats.mtimeMs
    ) {
      return cached.events
    }
    const events = readFileSync(path, 'utf8')
      .split('\n')
      .flatMap(line => {
        if (!line.trim()) return []
        try {
          const event = parseEvent(JSON.parse(line))
          return event ? [event] : []
        } catch {
          return []
        }
      })
    eventsCache.set(path, {
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      events,
    })
    return events
  } catch {
    return []
  }
}

function replayEvents(
  events: readonly ProjectLearningEvent[],
): ProjectLearningRecord[] {
  const records = new Map<string, ProjectLearningRecord>()
  for (const event of events) {
    if (event.type === 'upsert') {
      records.set(event.learning.id, event.learning)
      continue
    }
    const record = records.get(event.id)
    if (!record) continue
    records.set(event.id, {
      ...record,
      status: 'retired',
      updatedAt: event.at,
      retiredAt: event.at,
      ...(event.reason ? { retirementReason: event.reason } : {}),
    })
  }
  return [...records.values()]
}

function appendJsonl(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  appendJsonlAsync({
    filePath: path,
    entry: `${JSON.stringify(value)}\n`,
    mode: 0o600,
  })
  eventsCache.delete(path)
}

function jsonlSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function atomicRewriteJsonl(path: string, lines: string[]): void {
  if (lines.length === 0) {
    writeFileSync(path, '', { encoding: 'utf8', mode: 0o600 })
  } else {
    const tempPath = `${path}.tmp`
    writeFileSync(tempPath, `${lines.join('\n')}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    renameSync(tempPath, path)
  }
  eventsCache.delete(path)
}

/**
 * Rewrites the event log as one upsert per current record, dropping retired
 * state transitions while preserving the resulting statuses. Called under the
 * store lock so replay cost and disk usage stay bounded as the project ages.
 */
function compactEventLog(path: string): void {
  try {
    const records = replayEvents(readEvents(path))
    atomicRewriteJsonl(
      path,
      records.map(record => {
        const event: ProjectLearningEvent = {
          schemaVersion: PROJECT_LEARNING_SCHEMA_VERSION,
          type: 'upsert',
          at: record.updatedAt,
          learning: record,
        }
        return JSON.stringify(event)
      }),
    )
  } catch {
    // Best-effort: a failing compaction must not break the store.
  }
}

/**
 * Trims the context-snapshot log to the newest entries so capture-heavy
 * sessions cannot grow it without bound.
 */
function compactSnapshotLog(path: string): void {
  try {
    const parsed = readFileSync(path, 'utf8')
      .split('\n')
      .flatMap(line => {
        if (!line.trim()) return []
        try {
          const snapshot = parseSnapshot(JSON.parse(line))
          return snapshot ? [snapshot] : []
        } catch {
          return []
        }
      })
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, SNAPSHOT_LOG_COMPACT_MAX_ENTRIES)
    atomicRewriteJsonl(
      path,
      parsed.map(snapshot => JSON.stringify(snapshot)),
    )
  } catch {
    // Best-effort: an unreadable snapshot log is left untouched.
  }
}

function getStorageRoot(storageRoot?: string): string {
  return storageRoot ? resolve(storageRoot) : (testStorageRoot ?? getKodeRoot())
}

export function getProjectLearningStoreDir(
  scope: ProjectLearningScope,
): string {
  const project = getProjectScope(scope.cwd)
  return join(
    getStorageRoot(scope.storageRoot),
    'learning',
    'projects',
    project.id,
  )
}

export function getProjectLearningEventsPath(
  scope: ProjectLearningScope,
): string {
  return join(getProjectLearningStoreDir(scope), EVENTS_FILENAME)
}

export function getProjectContextSnapshotsPath(
  scope: ProjectLearningScope,
): string {
  return join(getProjectLearningStoreDir(scope), SNAPSHOTS_FILENAME)
}

function ensureScopeMetadata(scope: ProjectLearningScope): void {
  const project = getProjectScope(scope.cwd)
  const directory = getProjectLearningStoreDir(scope)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const scopePath = join(directory, SCOPE_FILENAME)
  if (existsSync(scopePath)) return
  writeFileSync(
    scopePath,
    `${JSON.stringify({
      version: 1,
      scopeId: project.id,
      rootPath: project.rootPath,
      kind: project.kind,
      createdAt: Date.now(),
    })}\n`,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' },
  )
}

function sanitizeCandidate(
  candidate: ProjectLearningCandidate,
): ProjectLearningCandidate | null {
  const text = cleanText(redactSensitiveMemoryText(candidate.text).text)
  if (
    !text ||
    isSensitiveOnlyMemory(text) ||
    UNSAFE_AUTOMATIC_DIRECTIVE.test(text)
  ) {
    return null
  }
  const kind = parseKind(candidate.kind)
  if (!kind) return null
  return { text, kind, pathPrefixes: cleanPathPrefixes(candidate.pathPrefixes) }
}

function uniqueEvidence(
  evidence: readonly ProjectLearningEvidence[],
): ProjectLearningEvidence[] {
  const ids = new Set<string>()
  const result: ProjectLearningEvidence[] = []
  for (const item of evidence) {
    if (ids.has(item.sourceId)) continue
    ids.add(item.sourceId)
    result.push(item)
    if (result.length >= MAX_EVIDENCE) break
  }
  return result
}

function confidenceForEvidence(evidence: readonly ProjectLearningEvidence[]): {
  status: ProjectLearningRecord['status']
  confidence: number
} {
  const sessions = new Set(evidence.map(item => item.sessionId))
  if (sessions.size >= 2) {
    return {
      status: 'active',
      confidence: Math.min(0.9, 0.65 + Math.max(0, sessions.size - 2) * 0.05),
    }
  }
  return { status: 'candidate', confidence: 0.45 }
}

export function listProjectLearnings(
  input: ProjectLearningListInput,
): ProjectLearningRecord[] {
  const scopeId = getProjectScope(input.cwd).id
  const limit = Math.max(0, Math.min(1_000, input.limit ?? 100))
  if (limit === 0) return []
  return replayEvents(readEvents(getProjectLearningEventsPath(input)))
    .filter(record => record.scopeId === scopeId)
    .filter(record => input.includeRetired || record.status !== 'retired')
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    .slice(0, limit)
}

/**
 * Records a lesson produced by compaction. A lesson remains a candidate until
 * distinct sessions independently support it; no generated text is promoted
 * to a durable instruction after a single model response.
 */
export function observeProjectLearning(
  input: ObserveProjectLearningInput,
): ProjectLearningRecord | null {
  const candidate = sanitizeCandidate(input.candidate)
  const sourceId = cleanId(input.sourceId)
  const sessionId = cleanId(input.sessionId)
  if (!candidate || !sourceId || !sessionId) return null

  const scope = getProjectScope(input.cwd)
  const now = input.now ?? Date.now()
  const normalizedText = normalizeText(candidate.text)
  const recordFingerprint = fingerprint(normalizedText)
  const directory = getProjectLearningStoreDir(input)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const release = acquireLock(join(directory, LOCK_FILENAME))
  if (!release)
    throw new Error('Failed to acquire project learning store lock.')

  try {
    ensureScopeMetadata(input)
    const records = replayEvents(
      readEvents(getProjectLearningEventsPath(input)),
    )
    const existing = records.find(
      record =>
        record.scopeId === scope.id && record.fingerprint === recordFingerprint,
    )
    if (existing?.status === 'retired') return existing

    const nextEvidence = uniqueEvidence([
      ...(existing?.evidence ?? []),
      {
        sourceId,
        sessionId,
        observedAt: now,
        workspace: input.workspace ?? {},
      },
    ])
    if (existing && nextEvidence.length === existing.evidence.length) {
      return existing
    }
    const activation = confidenceForEvidence(nextEvidence)
    const record: ProjectLearningRecord = {
      id: existing?.id ?? randomUUID(),
      scopeId: scope.id,
      text: candidate.text,
      normalizedText,
      fingerprint: recordFingerprint,
      kind: candidate.kind,
      status: activation.status,
      confidence: activation.confidence,
      pathPrefixes: cleanPathPrefixes([
        ...(existing?.pathPrefixes ?? []),
        ...candidate.pathPrefixes,
      ]),
      evidence: nextEvidence,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    appendJsonl(getProjectLearningEventsPath(input), {
      schemaVersion: PROJECT_LEARNING_SCHEMA_VERSION,
      type: 'upsert',
      at: now,
      learning: record,
    } satisfies ProjectLearningEvent)
    if (
      jsonlSize(getProjectLearningEventsPath(input)) >
      EVENT_LOG_COMPACT_MAX_BYTES
    ) {
      compactEventLog(getProjectLearningEventsPath(input))
    }
    return record
  } finally {
    release()
  }
}

export function retireProjectLearning(
  input: RetireProjectLearningInput,
): boolean {
  const id = cleanId(input.id)
  if (!id) return false
  const directory = getProjectLearningStoreDir(input)
  if (!existsSync(directory)) return false
  const release = acquireLock(join(directory, LOCK_FILENAME))
  if (!release)
    throw new Error('Failed to acquire project learning store lock.')

  try {
    const exists = listProjectLearnings({
      ...input,
      includeRetired: true,
    }).some(record => record.id === id && record.status !== 'retired')
    if (!exists) return false
    const reason = cleanText(input.reason, 320) || undefined
    appendJsonl(getProjectLearningEventsPath(input), {
      schemaVersion: PROJECT_LEARNING_SCHEMA_VERSION,
      type: 'retire',
      at: input.now ?? Date.now(),
      id,
      ...(reason ? { reason } : {}),
    } satisfies ProjectLearningEvent)
    if (
      jsonlSize(getProjectLearningEventsPath(input)) >
      EVENT_LOG_COMPACT_MAX_BYTES
    ) {
      compactEventLog(getProjectLearningEventsPath(input))
    }
    return true
  } finally {
    release()
  }
}

function runGit(cwd: string, args: string[]): string | null {
  try {
    const output = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 750,
    }).trim()
    return output || null
  } catch {
    return null
  }
}

export function getProjectWorkspaceRevision(
  cwd: string,
): ProjectWorkspaceRevision {
  const scope = getProjectScope(cwd)
  if (scope.kind !== 'git') return {}
  const gitHead = runGit(scope.rootPath, ['rev-parse', '--verify', 'HEAD'])
  const branch = runGit(scope.rootPath, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'HEAD',
  ])
  const status = runGit(scope.rootPath, [
    'status',
    '--porcelain=v1',
    '--untracked-files=normal',
  ])
  const workspaceFingerprint = createHash('sha256')
    .update(gitHead ?? '<no-head>')
    .update('\0')
    .update(branch ?? '<detached>')
    .update('\0')
    .update(status ?? '')
    .digest('hex')
  return {
    ...(gitHead ? { gitHead } : {}),
    gitBranch: branch,
    workspaceFingerprint,
  }
}

function parseSnapshot(value: unknown): ProjectContextSnapshot | null {
  if (!isRecord(value)) return null
  const id = cleanId(value.id)
  const sessionId = cleanId(value.sessionId)
  const leafUuid = cleanId(value.leafUuid)
  const summary = cleanSummary(
    redactSensitiveMemoryText(String(value.summary ?? '')).text,
  )
  const createdAt = asFiniteTime(value.createdAt)
  const scopeValue = isRecord(value.scope) ? value.scope : null
  const scopeId = cleanId(scopeValue?.id, 100)
  const rootPath = cleanId(scopeValue?.rootPath, 4_000)
  const kind =
    scopeValue?.kind === 'git' || scopeValue?.kind === 'directory'
      ? scopeValue.kind
      : null
  if (
    !id ||
    !sessionId ||
    !leafUuid ||
    !summary ||
    !createdAt ||
    !scopeId ||
    !rootPath ||
    !kind
  ) {
    return null
  }
  return {
    id,
    sessionId,
    leafUuid,
    summary,
    createdAt,
    scope: { id: scopeId, rootPath, kind },
    workspace: parseWorkspace(value.workspace),
  }
}

export function captureProjectContextSnapshot(
  input: CaptureProjectContextSnapshotInput,
): ProjectContextSnapshot | null {
  const sessionId = cleanId(input.sessionId)
  const leafUuid = cleanId(input.leafUuid)
  const summary = cleanSummary(redactSensitiveMemoryText(input.summary).text)
  if (!sessionId || !leafUuid || !summary || isSensitiveOnlyMemory(summary)) {
    return null
  }
  const scope = getProjectScope(input.cwd)
  const directory = getProjectLearningStoreDir(input)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const release = acquireLock(join(directory, LOCK_FILENAME))
  if (!release)
    throw new Error('Failed to acquire project learning store lock.')
  try {
    ensureScopeMetadata(input)
    const snapshot: ProjectContextSnapshot = {
      id: randomUUID(),
      scope,
      sessionId,
      leafUuid,
      summary,
      workspace: input.workspace ?? getProjectWorkspaceRevision(input.cwd),
      createdAt: input.now ?? Date.now(),
    }
    appendJsonl(getProjectContextSnapshotsPath(input), snapshot)
    if (
      jsonlSize(getProjectContextSnapshotsPath(input)) >
      SNAPSHOT_LOG_COMPACT_MAX_BYTES
    ) {
      compactSnapshotLog(getProjectContextSnapshotsPath(input))
    }
    return snapshot
  } finally {
    release()
  }
}

export function listProjectContextSnapshots(
  input: ProjectLearningScope & { sessionId?: string; limit?: number },
): ProjectContextSnapshot[] {
  const scope = getProjectScope(input.cwd)
  const limit = Math.max(0, Math.min(1_000, input.limit ?? 100))
  if (limit === 0) return []
  const path = getProjectContextSnapshotsPath(input)
  flushPendingSync(path)
  if (!existsSync(path)) return []
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .flatMap(line => {
        if (!line.trim()) return []
        try {
          const snapshot = parseSnapshot(JSON.parse(line))
          return snapshot ? [snapshot] : []
        } catch {
          return []
        }
      })
      .filter(snapshot => snapshot.scope.id === scope.id)
      .filter(
        snapshot => !input.sessionId || snapshot.sessionId === input.sessionId,
      )
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
  } catch {
    return []
  }
}

export function __resetProjectLearningStoreForTests(
  scope: ProjectLearningScope,
): void {
  for (const path of [
    getProjectLearningEventsPath(scope),
    getProjectContextSnapshotsPath(scope),
  ]) {
    try {
      if (existsSync(path))
        writeFileSync(path, '', { encoding: 'utf8', mode: 0o600 })
      eventsCache.delete(path)
    } catch {
      // Tests can isolate with a temporary storage root.
    }
  }
}

export function __setProjectLearningStorageRootForTests(
  storageRoot: string | null,
): void {
  testStorageRoot = storageRoot ? resolve(storageRoot) : undefined
  eventsCache.clear()
}

/**
 * Test-only hook exposing the store lock so ownership semantics can be
 * verified without interleaving full store operations.
 */
export function __acquireProjectLearningLockForTests(
  directory: string,
): (() => void) | null {
  return acquireLock(join(directory, LOCK_FILENAME))
}

/**
 * Test-only override for the event-log compaction threshold.
 */
export function __setProjectLearningCompactThresholdForTests(
  bytes: number | null,
): void {
  EVENT_LOG_COMPACT_MAX_BYTES =
    bytes !== null && Number.isFinite(bytes) && bytes > 0 ? bytes : 512 * 1024
}
