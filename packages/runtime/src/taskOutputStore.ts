import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { dirname, join } from 'path'
import { getKodeRoot } from '#config/dataRoots'
import { LEGACY_ENV } from '#config/compat/legacyEnv'
import { resolveSandboxTmpDir } from './shell/sandboxEnv'

function getKodeBaseDir(): string {
  return getKodeRoot()
}

// Compatibility: project directory is a sanitized cwd string.
function getProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

function getProjectRootForTaskOutputs(): string {
  const override = process.env.KODE_PROJECT_DIR
  if (typeof override === 'string' && override.trim()) return override.trim()

  const legacyOverride = process.env[LEGACY_ENV.projectDir]
  if (typeof legacyOverride === 'string' && legacyOverride.trim())
    return legacyOverride.trim()

  return process.cwd()
}

const OUTPUT_FLUSH_INTERVAL_MS = 40
const MAX_BUFFERED_OUTPUT_BYTES = 64 * 1024
/**
 * Hard cap for the on-disk `.output` file. Tail readers only ever surface the
 * newest bytes, so keeping the whole history would grow the file without
 * bound. The newest output always wins; a flush that would exceed the cap
 * rewrites the file with its tail instead of appending.
 */
export const MAX_OUTPUT_FILE_BYTES = 1024 * 1024

type TaskOutputBuffer = {
  filePath: string
  chunks: string[]
  byteLength: number
  timer: ReturnType<typeof setTimeout> | null
}

const bufferedOutputByTask = new Map<string, TaskOutputBuffer>()

function scheduleTaskOutputFlush(
  taskId: string,
  buffer: TaskOutputBuffer,
): void {
  if (buffer.timer !== null) return
  buffer.timer = setTimeout(() => {
    buffer.timer = null
    flushTaskOutput(taskId)
  }, OUTPUT_FLUSH_INTERVAL_MS)
  buffer.timer.unref?.()
}

function getTaskOutputBuffer(taskId: string): TaskOutputBuffer {
  const existing = bufferedOutputByTask.get(taskId)
  if (existing) return existing

  // Set up permissions and the user-facing symlink once for a burst of output
  // instead of performing those filesystem operations for every stream chunk.
  touchTaskOutputFile(taskId)
  const buffer: TaskOutputBuffer = {
    filePath: getTaskOutputStoreFilePath(taskId),
    chunks: [],
    byteLength: 0,
    timer: null,
  }
  bufferedOutputByTask.set(taskId, buffer)
  return buffer
}

export function getTaskOutputsStoreDir(): string {
  return join(
    getKodeBaseDir(),
    getProjectDir(getProjectRootForTaskOutputs()),
    'tasks',
  )
}

export function getTaskOutputsUserFacingDir(): string {
  const tmpBase = resolveSandboxTmpDir()
  return join(tmpBase, getProjectDir(getProjectRootForTaskOutputs()), 'tasks')
}

export function getTaskOutputStoreFilePath(taskId: string): string {
  return join(getTaskOutputsStoreDir(), `${taskId}.output`)
}

export function getTaskOutputUserFacingFilePath(taskId: string): string {
  return join(getTaskOutputsUserFacingDir(), `${taskId}.output`)
}

export function ensureTaskOutputsDirExists(): void {
  const storeDir = getTaskOutputsStoreDir()
  if (!existsSync(storeDir))
    mkdirSync(storeDir, { recursive: true, mode: 0o700 })
  ensurePrivateMode(storeDir, 0o700)

  const userFacingDir = getTaskOutputsUserFacingDir()
  if (!existsSync(userFacingDir))
    mkdirSync(userFacingDir, { recursive: true, mode: 0o700 })
  ensurePrivateMode(userFacingDir, 0o700)
}

function isSymlink(filePath: string): boolean {
  try {
    return lstatSync(filePath).isSymbolicLink()
  } catch {
    return false
  }
}

function ensurePrivateMode(filePath: string, mode: number): void {
  try {
    chmodSync(filePath, mode)
  } catch {
    // Best-effort on filesystems/platforms without POSIX mode support.
  }
}

function tryEnsureUserFacingSymlink(taskId: string): boolean {
  const storeFilePath = getTaskOutputStoreFilePath(taskId)
  const userFacingFilePath = getTaskOutputUserFacingFilePath(taskId)
  try {
    const parent = dirname(userFacingFilePath)
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 })

    if (existsSync(userFacingFilePath)) {
      return isSymlink(userFacingFilePath)
    }

    // Windows can require the "type" arg, but it's harmless elsewhere.
    symlinkSync(storeFilePath, userFacingFilePath, 'file')
    return true
  } catch {
    return false
  }
}

export function touchTaskOutputFile(taskId: string): string {
  flushTaskOutput(taskId)
  ensureTaskOutputsDirExists()
  const storeFilePath = getTaskOutputStoreFilePath(taskId)
  if (!existsSync(storeFilePath)) {
    const parent = dirname(storeFilePath)
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 })
    writeFileSync(storeFilePath, '', { encoding: 'utf8', mode: 0o600 })
  }
  ensurePrivateMode(storeFilePath, 0o600)

  return tryEnsureUserFacingSymlink(taskId)
    ? getTaskOutputUserFacingFilePath(taskId)
    : storeFilePath
}

export function getTaskOutputFilePath(taskId: string): string {
  flushTaskOutput(taskId)
  const storeFilePath = getTaskOutputStoreFilePath(taskId)
  const userFacingFilePath = getTaskOutputUserFacingFilePath(taskId)

  if (existsSync(userFacingFilePath) && isSymlink(userFacingFilePath)) {
    return userFacingFilePath
  }

  if (existsSync(storeFilePath) && tryEnsureUserFacingSymlink(taskId)) {
    return userFacingFilePath
  }

  return storeFilePath
}

export function appendTaskOutput(taskId: string, chunk: string): void {
  if (!chunk) return
  try {
    const buffer = getTaskOutputBuffer(taskId)
    buffer.chunks.push(chunk)
    buffer.byteLength += Buffer.byteLength(chunk)
    if (buffer.byteLength >= MAX_BUFFERED_OUTPUT_BYTES) {
      flushTaskOutput(taskId)
    } else {
      scheduleTaskOutputFlush(taskId, buffer)
    }
  } catch {
    // Best-effort: never crash the session on output persistence failures.
  }
}

/**
 * Reads the newest `maxBytes` bytes of a file without loading the whole file.
 * Returns '' when the file is missing, empty, or `maxBytes` is not positive.
 */
function readTailBytes(filePath: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  try {
    const size = statSync(filePath).size
    if (size <= 0) return ''
    const length = Math.min(size, maxBytes)
    const start = size - length
    const fd = openSync(filePath, 'r')
    try {
      const buf = Buffer.allocUnsafe(length)
      const bytesRead = readSync(fd, buf, 0, length, start)
      return buf.subarray(0, bytesRead).toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

/** Keeps only the newest `maxBytes` bytes, cutting at a UTF-8 boundary. */
function trimUtf8Tail(content: string, maxBytes: number): string {
  const buf = Buffer.from(content, 'utf8')
  if (buf.length <= maxBytes) return content
  let start = buf.length - maxBytes
  // Skip continuation bytes so a multi-byte character is never split.
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++
  return buf.subarray(start).toString('utf8')
}

/**
 * Writes the newest `maxBytes` bytes of the on-disk file plus `content`,
 * atomically. Used by the flush path to keep `.output` files bounded without
 * ever exposing a partially rewritten file to concurrent readers.
 */
function rewriteBoundedOutput(filePath: string, content: string): void {
  const contentBytes = Buffer.byteLength(content)
  const keptBytes = Math.max(0, MAX_OUTPUT_FILE_BYTES - contentBytes)
  const combined = trimUtf8Tail(
    readTailBytes(filePath, keptBytes) + content,
    MAX_OUTPUT_FILE_BYTES,
  )
  const temporaryPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  writeFileSync(temporaryPath, combined, { encoding: 'utf8', mode: 0o600 })
  try {
    renameSync(temporaryPath, filePath)
  } catch (error) {
    try {
      rmSync(temporaryPath, { force: true })
    } catch {
      // Best-effort cleanup.
    }
    throw error
  }
}

/**
 * Flush one task's buffered stream chunks. Shell/agent completion paths call
 * this explicitly; read APIs also call it so their existing immediate-read
 * contract remains intact.
 */
export function flushTaskOutput(taskId: string): void {
  const buffer = bufferedOutputByTask.get(taskId)
  if (!buffer || buffer.chunks.length === 0) return
  if (buffer.timer !== null) {
    clearTimeout(buffer.timer)
    buffer.timer = null
  }
  try {
    const content = buffer.chunks.join('')
    const existingSize = existsSync(buffer.filePath)
      ? statSync(buffer.filePath).size
      : 0
    if (existingSize + Buffer.byteLength(content) <= MAX_OUTPUT_FILE_BYTES) {
      appendFileSync(buffer.filePath, content, {
        encoding: 'utf8',
        mode: 0o600,
      })
    } else {
      rewriteBoundedOutput(buffer.filePath, content)
    }
    ensurePrivateMode(buffer.filePath, 0o600)
    bufferedOutputByTask.delete(taskId)
  } catch {
    // Keep the batch in memory so a later append, read, controlled completion,
    // or process exit can retry it without reordering output.
  }
}

/** Flush all outstanding chunks for controlled shutdown and process exit. */
export function flushAllTaskOutputs(): void {
  for (const taskId of bufferedOutputByTask.keys()) flushTaskOutput(taskId)
}

let exitFlushRegistered = false

function registerExitFlush(): void {
  if (exitFlushRegistered) return
  exitFlushRegistered = true
  process.on('exit', flushAllTaskOutputs)
}

registerExitFlush()

export function readTaskOutputDelta(
  taskId: string,
  offset: number,
): {
  content: string
  newOffset: number
} {
  flushTaskOutput(taskId)
  // NOTE: the underlying file is capped at MAX_OUTPUT_FILE_BYTES; once the
  // newest output is trimmed, byte offsets from before the trim are stale and
  // this API returns an empty delta. Callers that need the full history must
  // re-sync from a fresh base (or use the tail readers).
  try {
    const filePath = getTaskOutputStoreFilePath(taskId)
    if (!existsSync(filePath)) return { content: '', newOffset: offset }
    const size = statSync(filePath).size
    const start = Math.max(0, Math.min(size, Math.floor(offset)))
    if (size <= start) return { content: '', newOffset: start }

    const length = size - start
    const fd = openSync(filePath, 'r')
    try {
      const buffer = Buffer.allocUnsafe(length)
      const bytesRead = readSync(fd, buffer, 0, length, start)
      return {
        content: buffer.subarray(0, bytesRead).toString('utf8'),
        newOffset: start + bytesRead,
      }
    } finally {
      closeSync(fd)
    }
  } catch {
    return { content: '', newOffset: offset }
  }
}

export function readTaskOutput(taskId: string): string {
  flushTaskOutput(taskId)
  try {
    const filePath = getTaskOutputStoreFilePath(taskId)
    if (!existsSync(filePath)) return ''
    return readFileSync(filePath, 'utf8')
  } catch {
    return ''
  }
}

export function readTaskOutputTail(
  taskId: string,
  maxBytes: number,
): { content: string; wasTruncated: boolean } {
  flushTaskOutput(taskId)
  try {
    const filePath = getTaskOutputStoreFilePath(taskId)
    if (!existsSync(filePath)) return { content: '', wasTruncated: false }
    const size = statSync(filePath).size
    if (size <= 0 || maxBytes <= 0) {
      return { content: '', wasTruncated: size > 0 }
    }

    const length = Math.min(size, Math.max(1, Math.floor(maxBytes)))
    const start = size - length
    const fd = openSync(filePath, 'r')
    try {
      const buffer = Buffer.allocUnsafe(length)
      const bytesRead = readSync(fd, buffer, 0, length, start)
      return {
        content: buffer.subarray(0, bytesRead).toString('utf8'),
        wasTruncated: start > 0,
      }
    } finally {
      closeSync(fd)
    }
  } catch {
    return { content: '', wasTruncated: false }
  }
}

export function readTaskOutputTailLines(
  taskId: string,
  maxLines: number,
): string[] {
  flushTaskOutput(taskId)
  try {
    const lineLimit = Math.max(0, Math.floor(maxLines))
    if (lineLimit === 0) return []
    const filePath = getTaskOutputStoreFilePath(taskId)
    if (!existsSync(filePath)) return []

    const size = statSync(filePath).size
    if (size <= 0) return []

    const MAX_BYTES = 64 * 1024
    const start = Math.max(0, size - MAX_BYTES)
    const length = size - start
    if (length <= 0) return []

    const fd = openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(length)
      readSync(fd, buf, 0, length, start)
      let text = buf.toString('utf8')
      if (start > 0) {
        const firstNewline = text.indexOf('\n')
        if (firstNewline >= 0) text = text.slice(firstNewline + 1)
        else {
          // A bounded tail of a very large single line is still useful. Keep
          // it visibly marked as partial instead of making /tasks claim that
          // the task produced no output at all.
          const PARTIAL_LINE_BYTES = 4 * 1024
          const partial = buf
            .subarray(Math.max(0, buf.length - PARTIAL_LINE_BYTES))
            .toString('utf8')
            .replace(/^\uFFFD+/u, '')
          text = `[Earlier output omitted; showing partial final line]\n${partial}`
        }
      }
      if (!text) return []

      const lines = text.replace(/\r\n/g, '\n').split('\n')
      return lines.slice(-lineLimit)
    } finally {
      closeSync(fd)
    }
  } catch {
    return []
  }
}
