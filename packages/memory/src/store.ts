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

import { isSensitiveOnlyMemory, redactSensitiveMemoryText } from './redaction'
import {
  MEMORY_SCHEMA_VERSION,
  type MemoryEvent,
  type MemoryForgetInput,
  type MemoryListInput,
  type MemoryRecord,
  type MemoryRememberInput,
  type MemoryScope,
  type MemorySource,
  type NormalizedMemorySource,
} from './types'

const EVENTS_FILENAME = 'memories.jsonl'
const LOCK_FILENAME = '.lock'
const LOCK_STALE_MS = 10_000
const LOCK_RETRIES = 5
const LOCK_RETRY_DELAY_MS = 25
const MAX_MEMORY_TEXT_LENGTH = 1_200
const MAX_SOURCE_LENGTH = 240
const MAX_TAGS = 12
const MAX_TAG_LENGTH = 32
// Compacting rewrites the whole log, so the threshold must be low enough that
// the rewrite stays cheap yet high enough that it does not run constantly.
let EVENT_LOG_COMPACT_MAX_BYTES = 512 * 1024

type CachedEvents = {
  size: number
  mtimeMs: number
  events: MemoryEvent[]
}

// The memory store is read on the per-turn message-pipeline hot path
// (extractLongTermMemories + getRelevantMemories). Keep a stat-keyed cache so
// an unchanged event log is not re-read and re-parsed for every turn.
const eventsCache = new Map<string, CachedEvents>()

function sleepSync(ms: number): void {
  if (ms <= 0) return
  const view = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(view, 0, 0, ms)
}

function safeUnlink(filePath: string): void {
  try {
    unlinkSync(filePath)
  } catch {
    // A best-effort lock cleanup should not hide the primary error.
  }
}

function acquireLock(lockPath: string): (() => void) | null {
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    try {
      writeFileSync(lockPath, `${process.pid} ${Date.now()}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      })
      return () => safeUnlink(lockPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST') {
        return null
      }
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          safeUnlink(lockPath)
        }
      } catch {
        // The competing process may have completed between operations.
      }
      sleepSync(LOCK_RETRY_DELAY_MS)
    }
  }
  return null
}

function asFiniteTime(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function cleanText(value: unknown, maxLength = MAX_MEMORY_TEXT_LENGTH): string {
  return String(value ?? '')
    .replace(/\u0000/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function cleanTags(tags: readonly string[] | undefined): string[] {
  const unique = new Set<string>()
  for (const candidate of tags ?? []) {
    const clean = cleanText(candidate, MAX_TAG_LENGTH)
      .toLowerCase()
      .replace(/[^a-z0-9_./-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
    if (clean) unique.add(clean)
    if (unique.size >= MAX_TAGS) break
  }
  return [...unique]
}

function clampConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.8
  return Math.max(0, Math.min(1, value))
}

function cleanSourceValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const redacted = redactSensitiveMemoryText(
    cleanText(value, MAX_SOURCE_LENGTH),
  )
  const clean = redacted.text.trim()
  return clean || undefined
}

function normalizeSource(
  source: MemorySource | undefined,
): NormalizedMemorySource | undefined {
  if (!source) return undefined
  if (typeof source === 'string') {
    const label = cleanSourceValue(source)
    return label ? { kind: 'manual', label } : undefined
  }

  const kind = cleanSourceValue(source.kind) ?? 'unknown'
  const id = cleanSourceValue(source.id)
  const label = cleanSourceValue(source.label)
  return { kind, ...(id ? { id } : {}), ...(label ? { label } : {}) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeStoredSource(
  value: unknown,
): NormalizedMemorySource | undefined {
  if (!isRecord(value)) return undefined
  const kind = cleanSourceValue(value.kind) ?? 'unknown'
  const id = cleanSourceValue(value.id)
  const label = cleanSourceValue(value.label)
  return { kind, ...(id ? { id } : {}), ...(label ? { label } : {}) }
}

function parseRecord(value: unknown): MemoryRecord | null {
  if (!isRecord(value)) return null
  const id = cleanText(value.id, 100)
  const text = cleanText(value.text)
  const normalizedText = cleanText(value.normalizedText)
  const rawFingerprint = cleanText(value.fingerprint, 100)
  const createdAt = asFiniteTime(value.createdAt)
  const updatedAt = asFiniteTime(value.updatedAt)
  if (
    !id ||
    !text ||
    !normalizedText ||
    !rawFingerprint ||
    !createdAt ||
    !updatedAt
  ) {
    return null
  }

  const sanitized = redactSensitiveMemoryText(text)
  if (isSensitiveOnlyMemory(sanitized.text)) return null

  return {
    id,
    text: sanitized.text,
    normalizedText: normalizeText(sanitized.text),
    fingerprint: fingerprint(normalizeText(sanitized.text)),
    tags: cleanTags(Array.isArray(value.tags) ? value.tags : []),
    confidence: clampConfidence(value.confidence),
    source: normalizeStoredSource(value.source),
    createdAt,
    updatedAt,
    expiresAt: asFiniteTime(value.expiresAt),
  }
}

function parseEvent(value: unknown): MemoryEvent | null {
  if (!isRecord(value) || value.schemaVersion !== MEMORY_SCHEMA_VERSION)
    return null
  const at = asFiniteTime(value.at)
  if (!at) return null
  if (value.type === 'remember') {
    const memory = parseRecord(value.memory)
    return memory
      ? { schemaVersion: MEMORY_SCHEMA_VERSION, type: 'remember', at, memory }
      : null
  }
  if (value.type === 'forget') {
    const id = cleanText(value.id, 100)
    return id
      ? { schemaVersion: MEMORY_SCHEMA_VERSION, type: 'forget', at, id }
      : null
  }
  return null
}

function readEvents(filePath: string): MemoryEvent[] {
  flushPendingSync(filePath)
  if (!existsSync(filePath)) return []
  try {
    const stats = statSync(filePath)
    const cached = eventsCache.get(filePath)
    if (
      cached &&
      cached.size === stats.size &&
      cached.mtimeMs === stats.mtimeMs
    ) {
      return cached.events
    }
    const events = readFileSync(filePath, 'utf8')
      .split('\n')
      .flatMap(line => {
        if (!line.trim()) return []
        try {
          const event = parseEvent(JSON.parse(line))
          return event ? [event] : []
        } catch {
          // A partial/corrupt line must not make all historic memory unusable.
          return []
        }
      })
    eventsCache.set(filePath, {
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      events,
    })
    return events
  } catch {
    return []
  }
}

function replayEvents(events: readonly MemoryEvent[]): MemoryRecord[] {
  const records = new Map<string, MemoryRecord>()
  for (const event of events) {
    if (event.type === 'remember') records.set(event.memory.id, event.memory)
    else records.delete(event.id)
  }
  return [...records.values()]
}

function appendEvent(filePath: string, event: MemoryEvent): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
  appendJsonlAsync({
    filePath,
    entry: `${JSON.stringify(event)}\n`,
    mode: 0o600,
  })
  // The append is deferred; dropping the cache entry now forces the next read
  // (which flushes pending writes first) to observe the new line.
  eventsCache.delete(filePath)
}

function jsonlSize(filePath: string): number {
  try {
    return statSync(filePath).size
  } catch {
    return 0
  }
}

function atomicRewriteJsonl(filePath: string, lines: string[]): void {
  if (lines.length === 0) {
    writeFileSync(filePath, '', { encoding: 'utf8', mode: 0o600 })
  } else {
    const tempPath = `${filePath}.tmp`
    writeFileSync(tempPath, `${lines.join('\n')}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    renameSync(tempPath, filePath)
  }
  eventsCache.delete(filePath)
}

/**
 * Rewrites the event log as one remember event per current record, dropping
 * forget events while preserving the resulting record set. Called under the
 * store lock so replay cost and disk usage stay bounded as the project ages.
 */
function compactEventLog(filePath: string): void {
  try {
    const records = replayEvents(readEvents(filePath))
    atomicRewriteJsonl(
      filePath,
      records.map(record => {
        const event: MemoryEvent = {
          schemaVersion: MEMORY_SCHEMA_VERSION,
          type: 'remember',
          at: record.updatedAt,
          memory: record,
        }
        return JSON.stringify(event)
      }),
    )
  } catch {
    // Best-effort: a failing compaction must not break the store.
  }
}

function memoryProjectKey(cwd: string): string {
  const path = resolve(cwd).replace(/\\/g, '/')
  const normalized = process.platform === 'win32' ? path.toLowerCase() : path
  return createHash('sha256').update(normalized).digest('hex').slice(0, 24)
}

function assertCwd(cwd: string): string {
  const clean = String(cwd ?? '').trim()
  if (!clean) throw new Error('Memory storage requires a non-empty cwd.')
  return resolve(clean)
}

export function getMemoryStoreDir(scope: MemoryScope): string {
  const cwd = assertCwd(scope.cwd)
  const root = scope.storageRoot ? resolve(scope.storageRoot) : getKodeRoot()
  return join(root, 'memory', 'projects', memoryProjectKey(cwd))
}

export function getMemoryEventsPath(scope: MemoryScope): string {
  return join(getMemoryStoreDir(scope), EVENTS_FILENAME)
}

function isExpired(record: MemoryRecord, now: number): boolean {
  return record.expiresAt !== undefined && record.expiresAt <= now
}

export function listMemories(input: MemoryListInput): MemoryRecord[] {
  const now = input.now ?? Date.now()
  const limit = Math.max(0, Math.min(1_000, input.limit ?? 100))
  if (limit === 0) return []
  const records = replayEvents(readEvents(getMemoryEventsPath(input)))
    .filter(record => input.includeExpired || !isExpired(record, now))
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
  return records.slice(0, limit)
}

/**
 * Stores a redacted, bounded memory. Returns an existing record when the same
 * normalized fact is already present, and null for empty/sensitive-only input.
 */
export function rememberMemory(
  input: MemoryRememberInput,
): MemoryRecord | null {
  const rawText = cleanText(input.text)
  if (!rawText) return null
  const redacted = redactSensitiveMemoryText(rawText)
  const text = cleanText(redacted.text)
  if (!text || isSensitiveOnlyMemory(text)) return null

  const now = input.now ?? Date.now()
  const normalizedText = normalizeText(text)
  const recordFingerprint = fingerprint(normalizedText)
  const scope: MemoryScope = { cwd: input.cwd, storageRoot: input.storageRoot }
  const dir = getMemoryStoreDir(scope)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const release = acquireLock(join(dir, LOCK_FILENAME))
  if (!release) throw new Error('Failed to acquire memory store lock.')

  try {
    const existing = replayEvents(readEvents(getMemoryEventsPath(scope))).find(
      record => record.fingerprint === recordFingerprint,
    )
    if (existing) return existing

    const expiresAt = asFiniteTime(input.expiresAt)
    const memory: MemoryRecord = {
      id: randomUUID(),
      text,
      normalizedText,
      fingerprint: recordFingerprint,
      tags: cleanTags(input.tags),
      confidence: clampConfidence(input.confidence),
      source: normalizeSource(input.source),
      createdAt: now,
      updatedAt: now,
      ...(expiresAt && expiresAt > now ? { expiresAt } : {}),
    }
    appendEvent(getMemoryEventsPath(scope), {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      type: 'remember',
      at: now,
      memory,
    })
    const eventsPath = getMemoryEventsPath(scope)
    if (jsonlSize(eventsPath) > EVENT_LOG_COMPACT_MAX_BYTES) {
      compactEventLog(eventsPath)
    }
    return memory
  } finally {
    release()
  }
}

export function forgetMemory(input: MemoryForgetInput): boolean {
  const id = cleanText(input.id, 100)
  if (!id) return false
  const scope: MemoryScope = { cwd: input.cwd, storageRoot: input.storageRoot }
  const dir = getMemoryStoreDir(scope)
  if (!existsSync(dir)) return false
  const release = acquireLock(join(dir, LOCK_FILENAME))
  if (!release) throw new Error('Failed to acquire memory store lock.')

  try {
    const exists = replayEvents(readEvents(getMemoryEventsPath(scope))).some(
      record => record.id === id,
    )
    if (!exists) return false
    appendEvent(getMemoryEventsPath(scope), {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      type: 'forget',
      at: input.now ?? Date.now(),
      id,
    })
    const eventsPath = getMemoryEventsPath(scope)
    if (jsonlSize(eventsPath) > EVENT_LOG_COMPACT_MAX_BYTES) {
      compactEventLog(eventsPath)
    }
    return true
  } finally {
    release()
  }
}

export function __resetMemoryStoreForTests(scope: MemoryScope): void {
  // Test helper intentionally does not remove arbitrary user paths: it only
  // truncates this module's event file under the deterministic store directory.
  const filePath = getMemoryEventsPath(scope)
  try {
    if (existsSync(filePath)) writeFileSync(filePath, '', { mode: 0o600 })
  } catch {
    // Tests can still isolate through a temporary storageRoot.
  }
  eventsCache.delete(filePath)
}

/**
 * Test-only override for the event-log compaction threshold.
 */
export function __setMemoryCompactThresholdForTests(
  bytes: number | null,
): void {
  EVENT_LOG_COMPACT_MAX_BYTES =
    bytes !== null && Number.isFinite(bytes) && bytes > 0 ? bytes : 512 * 1024
}
