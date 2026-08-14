import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import { getClaudeCompatRoots, getKodeRoot } from '#config/dataRoots'
import { appendJsonlAsync, flushPendingSync } from '#core/utils/jsonlWriter'
import { LEGACY_ENV } from '#core/compat/legacyEnv'
import { getCurrentProjectConfig } from '#core/utils/config'
import { getCwd } from '#core/utils/state'
import { getKodeAgentSessionId } from '#protocol/utils/kodeAgentSessionId'

const MAX_HISTORY_ITEMS = 100
const PASTED_CONTENT_INLINE_MAX = 1024
const HISTORY_FILENAME = 'history.jsonl'
const PASTE_CACHE_DIRNAME = 'paste-cache'
const LOCK_STALE_MS = 10_000
const LOCK_RETRIES = 3

type HistoryPastedContentLine = {
  id: number
  type: 'text' | 'image'
  content?: string
  contentHash?: string
  mediaType?: string
  filename?: string
}

type HistoryLine = {
  display: string
  pastedContents?: Record<string, HistoryPastedContentLine>
  timestamp?: number
  project?: string
  sessionId?: string
}

export type PromptHistoryPastedContent = {
  id: number
  type: 'text' | 'image'
  content: string
  mediaType?: string
  filename?: string
}

export type PromptHistoryItem = {
  display: string
  pastedContents: Record<number, PromptHistoryPastedContent>
  timestamp: number
  project: string
  sessionId: string | null
}

export type HistoryPastedTextSegment = { placeholder: string; text: string }

type HistoryWriteInput =
  | string
  | {
      display: string
      pastedContents?: Record<
        number,
        {
          id: number
          type: 'text' | 'image'
          content: string
          mediaType?: string
          filename?: string
        }
      >
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeBoolean(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const normalized = value.trim().toLowerCase()
  return ['1', 'true', 'yes', 'y', 'on'].includes(normalized)
}

function shouldSkipPromptHistory(): boolean {
  if (normalizeBoolean(process.env.KODE_SKIP_PROMPT_HISTORY)) return true
  const legacy = process.env[LEGACY_ENV.codeSkipPromptHistory]
  return normalizeBoolean(legacy)
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

function getHistoryFilePath(root: string): string {
  return join(root, HISTORY_FILENAME)
}

function getHistoryFileKey(root: string): string {
  const historyFilePath = getHistoryFilePath(root)
  try {
    const st = statSync(historyFilePath)
    return `${root}:${st.size}:${st.mtimeMs}`
  } catch {
    return `${root}:missing`
  }
}

function getPasteCacheDir(root: string): string {
  return join(root, PASTE_CACHE_DIRNAME)
}

function getPasteCachePath(root: string, hash: string): string {
  return join(getPasteCacheDir(root), `${hash}.txt`)
}

function safeMkdir(dirPath: string): void {
  try {
    mkdirSync(dirPath, { recursive: true })
  } catch {
    // best-effort
  }
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // best-effort
  }
}

function sleepSync(ms: number): void {
  if (ms <= 0) return
  const buf = new SharedArrayBuffer(4)
  const arr = new Int32Array(buf)
  Atomics.wait(arr, 0, 0, ms)
}

function acquireFileLock(lockPath: string): (() => void) | null {
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600)
      try {
        writeFileSync(fd, `${process.pid} ${Date.now()}\n`, 'utf8')
      } catch {
        // ignore
      } finally {
        try {
          closeSync(fd)
        } catch {
          // ignore
        }
      }

      return () => safeUnlink(lockPath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code !== 'EEXIST') return null

      try {
        const st = statSync(lockPath)
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) safeUnlink(lockPath)
      } catch {
        // ignore
      }

      sleepSync(50)
    }
  }

  return null
}

function safeStorePaste(root: string, hash: string, content: string): void {
  try {
    const dirPath = getPasteCacheDir(root)
    safeMkdir(dirPath)
    const filePath = getPasteCachePath(root, hash)
    writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 })
  } catch {
    // best-effort
  }
}

function safeReadPaste(root: string, hash: string): string | null {
  try {
    return readFileSync(getPasteCachePath(root, hash), 'utf8')
  } catch {
    return null
  }
}

function normalizeHistoryWriteInput(input: HistoryWriteInput): {
  display: string
  pastedContents: Record<
    number,
    {
      id: number
      type: 'text' | 'image'
      content: string
      mediaType?: string
      filename?: string
    }
  >
} {
  if (typeof input === 'string') return { display: input, pastedContents: {} }
  return {
    display: input.display,
    pastedContents: input.pastedContents ?? {},
  }
}

function safeParseJsonLine(line: string): unknown | null {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
}

function normalizeHistoryLine(raw: unknown): HistoryLine | null {
  if (!isRecord(raw)) return null
  const display =
    typeof raw.display === 'string' ? String(raw.display).trim() : ''
  if (!display) return null

  const pastedContents = isRecord(raw.pastedContents)
    ? (raw.pastedContents as Record<string, HistoryPastedContentLine>)
    : undefined

  const timestamp =
    typeof raw.timestamp === 'number' && Number.isFinite(raw.timestamp)
      ? raw.timestamp
      : 0
  const project = typeof raw.project === 'string' ? raw.project : undefined
  const sessionId =
    typeof raw.sessionId === 'string' ? raw.sessionId : undefined

  return { display, pastedContents, timestamp, project, sessionId }
}

type ReverseJsonlScanResult<T> = { items: T[]; fileKey: string }

function scanJsonlFromEndUntil<T>(args: {
  filePath: string
  fileKey: string
  parseLine: (line: string) => T | null
  shouldStop: (items: T[]) => boolean
}): ReverseJsonlScanResult<T> {
  const out: T[] = []

  if (!existsSync(args.filePath)) return { items: out, fileKey: args.fileKey }

  let fd: number | null = null
  try {
    fd = openSync(args.filePath, 'r')
    const size = statSync(args.filePath).size
    const bufferSize = 64 * 1024
    const buffer = Buffer.allocUnsafe(bufferSize)

    let position = size
    let carry = ''

    while (position > 0 && !args.shouldStop(out)) {
      const readSize = Math.min(bufferSize, position)
      position -= readSize
      const bytesRead = readSync(fd, buffer, 0, readSize, position)
      const chunk = buffer.toString('utf8', 0, bytesRead)

      const data = chunk + carry
      const parts = data.split('\n')
      carry = parts.shift() ?? ''

      for (let i = parts.length - 1; i >= 0; i -= 1) {
        const rawLine = parts[i]
        const line = rawLine ? rawLine.trim() : ''
        if (!line) continue
        const parsed = args.parseLine(line)
        if (parsed) out.push(parsed)
        if (args.shouldStop(out)) break
      }
    }

    if (!args.shouldStop(out)) {
      const line = carry.trim()
      if (line) {
        const parsed = args.parseLine(line)
        if (parsed) out.push(parsed)
      }
    }
  } catch {
    // best-effort
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // ignore
      }
    }
  }

  return { items: out, fileKey: args.fileKey }
}

function loadPromptHistoryFromRoot(args: {
  root: string
  project: string
  maxItems: number
}): ReverseJsonlScanResult<PromptHistoryItem> {
  const historyFilePath = getHistoryFilePath(args.root)
  flushPendingSync(historyFilePath)

  let fileKey = `${args.root}:missing`
  try {
    const st = statSync(historyFilePath)
    fileKey = `${args.root}:${st.size}:${st.mtimeMs}`
  } catch {
    // ignore
  }

  return scanJsonlFromEndUntil({
    filePath: historyFilePath,
    fileKey,
    parseLine: line => {
      const raw = safeParseJsonLine(line)
      const normalized = normalizeHistoryLine(raw)
      if (!normalized) return null
      if (!normalized.project || normalized.project !== args.project)
        return null

      const pastedContents: Record<number, PromptHistoryPastedContent> = {}
      for (const [rawKey, value] of Object.entries(
        normalized.pastedContents ?? {},
      )) {
        const key = Number(rawKey)
        if (!Number.isFinite(key) || key <= 0) continue
        if (!value || typeof value !== 'object') continue

        if (value.type === 'image') continue

        const content =
          typeof value.content === 'string'
            ? value.content
            : typeof value.contentHash === 'string'
              ? safeReadPaste(args.root, value.contentHash)
              : null
        if (!content) continue

        pastedContents[key] = {
          id: value.id,
          type: value.type,
          content,
          mediaType: value.mediaType,
          filename: value.filename,
        }
      }

      return {
        display: normalized.display,
        pastedContents,
        timestamp: normalized.timestamp ?? 0,
        project: normalized.project,
        sessionId: normalized.sessionId ?? null,
      }
    },
    shouldStop: items => items.length >= args.maxItems,
  })
}

type PromptHistoryCache = {
  project: string
  fileKey: string
  items: PromptHistoryItem[]
}

let cache: PromptHistoryCache | null = null

function loadPromptHistoryForProject(project: string): PromptHistoryItem[] {
  const roots = [getKodeRoot(), ...getClaudeCompatRoots()]

  const fileKey = roots.map(root => getHistoryFileKey(root)).join('|')
  if (cache && cache.project === project && cache.fileKey === fileKey) {
    return cache.items
  }

  const perRoot: Array<ReverseJsonlScanResult<PromptHistoryItem>> = roots.map(
    root =>
      loadPromptHistoryFromRoot({ root, project, maxItems: MAX_HISTORY_ITEMS }),
  )

  const merged = perRoot.flatMap(r => r.items)
  merged.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))

  const seen = new Set<string>()
  const deduped: PromptHistoryItem[] = []
  for (const item of merged) {
    const key = `${item.sessionId ?? ''}:${item.timestamp}:${item.project}:${item.display}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(item)
    if (deduped.length >= MAX_HISTORY_ITEMS) break
  }

  const legacyHistory = getCurrentProjectConfig().history ?? []
  for (const display of legacyHistory) {
    if (deduped.length >= MAX_HISTORY_ITEMS) break
    if (deduped.some(item => item.display === display)) continue
    deduped.push({
      display,
      pastedContents: {},
      timestamp: 0,
      project,
      sessionId: null,
    })
  }

  cache = { project, fileKey, items: deduped }
  return deduped
}

export function getHistory(): string[] {
  const project = getCwd()
  return loadPromptHistoryForProject(project).map(item => item.display)
}

function loadGlobalPromptHistoryFromRoot(args: {
  root: string
  maxItems: number
}): ReverseJsonlScanResult<PromptHistoryItem> {
  const historyFilePath = getHistoryFilePath(args.root)
  flushPendingSync(historyFilePath)

  let fileKey = `${args.root}:missing`
  try {
    const st = statSync(historyFilePath)
    fileKey = `${args.root}:${st.size}:${st.mtimeMs}`
  } catch {
    // ignore
  }

  return scanJsonlFromEndUntil({
    filePath: historyFilePath,
    fileKey,
    parseLine: line => {
      const raw = safeParseJsonLine(line)
      const normalized = normalizeHistoryLine(raw)
      if (!normalized) return null

      const pastedContents: Record<number, PromptHistoryPastedContent> = {}
      for (const [rawKey, value] of Object.entries(
        normalized.pastedContents ?? {},
      )) {
        const key = Number(rawKey)
        if (!Number.isFinite(key) || key <= 0) continue
        if (!value || typeof value !== 'object') continue

        if (value.type === 'image') continue

        const content =
          typeof value.content === 'string'
            ? value.content
            : typeof value.contentHash === 'string'
              ? safeReadPaste(args.root, value.contentHash)
              : null
        if (!content) continue

        pastedContents[key] = {
          id: value.id,
          type: value.type,
          content,
          mediaType: value.mediaType,
          filename: value.filename,
        }
      }

      return {
        display: normalized.display,
        pastedContents,
        timestamp: normalized.timestamp ?? 0,
        project: normalized.project ?? '',
        sessionId: normalized.sessionId ?? null,
      }
    },
    shouldStop: items => items.length >= args.maxItems,
  })
}

type GlobalPromptHistoryCache = {
  maxItems: number
  fileKey: string
  items: PromptHistoryItem[]
}

let globalCache: GlobalPromptHistoryCache | null = null

function loadGlobalPromptHistory(maxItems: number): PromptHistoryItem[] {
  const roots = [getKodeRoot(), ...getClaudeCompatRoots()]
  const fileKey = roots.map(root => getHistoryFileKey(root)).join('|')
  if (
    globalCache &&
    globalCache.maxItems === maxItems &&
    globalCache.fileKey === fileKey
  ) {
    return globalCache.items
  }

  const perRoot: Array<ReverseJsonlScanResult<PromptHistoryItem>> = roots.map(
    root => loadGlobalPromptHistoryFromRoot({ root, maxItems }),
  )

  const merged = perRoot.flatMap(r => r.items)
  merged.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))

  const seen = new Set<string>()
  const deduped: PromptHistoryItem[] = []
  for (const item of merged) {
    const key = `${item.sessionId ?? ''}:${item.timestamp}:${item.project}:${item.display}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(item)
    if (deduped.length >= maxItems) break
  }

  globalCache = { maxItems, fileKey, items: deduped }
  return deduped
}

function extractPastedTextMatches(display: string): Array<{
  id: number
  match: string
}> {
  const matches: Array<{ id: number; match: string }> = []
  const regex =
    /\[(Pasted text|Image|\.\.\.Truncated text) #(\d+)(?: \+\d+ lines)?(\.)*\]/g
  for (const m of display.matchAll(regex)) {
    if (!m[0] || !m[2]) continue
    const id = Number(m[2])
    if (!Number.isFinite(id) || id <= 0) continue
    if (m[1] !== 'Pasted text') continue
    matches.push({ id, match: m[0] })
  }
  return matches
}

type HistoryWithPastesCache = {
  project: string
  fileKey: string
  items: Array<{
    display: string
    pastedTexts: HistoryPastedTextSegment[]
  }>
}

let historyWithPastesCache: HistoryWithPastesCache | null = null

type GlobalHistoryWithPastesCache = {
  maxItems: number
  fileKey: string
  items: Array<{
    display: string
    pastedTexts: HistoryPastedTextSegment[]
  }>
}

let globalHistoryWithPastesCache: GlobalHistoryWithPastesCache | null = null

export function getHistoryWithPastes(): Array<{
  display: string
  pastedTexts: HistoryPastedTextSegment[]
}> {
  const project = getCwd()
  const roots = [getKodeRoot(), ...getClaudeCompatRoots()]
  const fileKey = roots.map(root => getHistoryFileKey(root)).join('|')
  if (
    historyWithPastesCache &&
    historyWithPastesCache.project === project &&
    historyWithPastesCache.fileKey === fileKey
  ) {
    return historyWithPastesCache.items
  }

  const items = loadPromptHistoryForProject(project).map(item => {
    const pastedTexts: HistoryPastedTextSegment[] = []
    for (const { id, match } of extractPastedTextMatches(item.display)) {
      const content = item.pastedContents[id]?.content
      if (!content) continue
      pastedTexts.push({ placeholder: match, text: content })
    }
    return { display: item.display, pastedTexts }
  })
  historyWithPastesCache = { project, fileKey, items }
  return items
}

export function getGlobalHistoryWithPastes(): Array<{
  display: string
  pastedTexts: HistoryPastedTextSegment[]
}> {
  const roots = [getKodeRoot(), ...getClaudeCompatRoots()]
  const fileKey = roots.map(root => getHistoryFileKey(root)).join('|')
  if (
    globalHistoryWithPastesCache &&
    globalHistoryWithPastesCache.maxItems === MAX_HISTORY_ITEMS &&
    globalHistoryWithPastesCache.fileKey === fileKey
  ) {
    return globalHistoryWithPastesCache.items
  }

  const items = loadGlobalPromptHistory(MAX_HISTORY_ITEMS).map(item => {
    const pastedTexts: HistoryPastedTextSegment[] = []
    for (const { id, match } of extractPastedTextMatches(item.display)) {
      const content = item.pastedContents[id]?.content
      if (!content) continue
      pastedTexts.push({ placeholder: match, text: content })
    }
    return { display: item.display, pastedTexts }
  })
  globalHistoryWithPastesCache = { maxItems: MAX_HISTORY_ITEMS, fileKey, items }
  return items
}

export function addToHistory(input: HistoryWriteInput): void {
  if (shouldSkipPromptHistory()) return

  const normalized = normalizeHistoryWriteInput(input)
  const display = normalized.display
  if (!display) return

  const project = getCwd()
  const existing = loadPromptHistoryForProject(project)
  if (existing[0]?.display === display) return

  const root = getKodeRoot()
  safeMkdir(dirname(getHistoryFilePath(root)))

  const pastedContents: Record<string, HistoryPastedContentLine> = {}
  for (const [rawId, content] of Object.entries(normalized.pastedContents)) {
    const id = Number(rawId)
    if (!Number.isFinite(id) || id <= 0) continue
    if (!content) continue

    if (content.type === 'image') continue

    if (content.content.length <= PASTED_CONTENT_INLINE_MAX) {
      pastedContents[String(id)] = {
        id: content.id,
        type: content.type,
        content: content.content,
        mediaType: content.mediaType,
        filename: content.filename,
      }
      continue
    }

    const contentHash = hashContent(content.content)
    pastedContents[String(id)] = {
      id: content.id,
      type: content.type,
      contentHash,
      mediaType: content.mediaType,
      filename: content.filename,
    }
    safeStorePaste(root, contentHash, content.content)
  }

  const record: HistoryLine = {
    display,
    pastedContents,
    timestamp: Date.now(),
    project,
    sessionId: getKodeAgentSessionId(),
  }

  const filePath = getHistoryFilePath(root)
  const release = acquireFileLock(`${filePath}.lock`)
  try {
    appendJsonlAsync({
      filePath,
      entry: JSON.stringify(record) + '\n',
      mode: 0o600,
    })
  } catch {
    // best-effort
  } finally {
    release?.()
  }

  cache = null
  historyWithPastesCache = null
  globalHistoryWithPastesCache = null
}
