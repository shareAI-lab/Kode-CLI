import { appendFileSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'

type PendingWrite = {
  filePath: string
  entry: string
  mode?: number
}

const pending = new Map<string, PendingWrite>()
// A failed append must remain durable in memory until a later flush can retry
// it. Keeping this separate from `pending` lets normal writes stay batched
// while making `flushJsonlWrites` accurately report an I/O failure.
const failed = new Map<string, PendingWrite>()
// Includes every async batch accepted for a file until its append succeeds.
// This is what lets the synchronous exit hook recover a batch that had left
// `pending` but was still waiting behind an earlier asynchronous write.
const scheduled = new Map<string, PendingWrite>()
const queues = new Map<string, Promise<void>>()
const inFlight = new Map<string, PendingWrite>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

function mergeWrites(earlier: PendingWrite, later: PendingWrite): PendingWrite {
  return {
    filePath: earlier.filePath,
    entry: `${earlier.entry}${later.entry}`,
    mode: earlier.mode ?? later.mode,
  }
}

function addScheduledWrite(write: PendingWrite): void {
  const previous = scheduled.get(write.filePath)
  scheduled.set(write.filePath, previous ? mergeWrites(previous, write) : write)
}

function removeScheduledWrite(write: PendingWrite): void {
  const current = scheduled.get(write.filePath)
  if (!current) return
  if (current.entry === write.entry) {
    scheduled.delete(write.filePath)
    return
  }
  if (current.entry.startsWith(write.entry)) {
    scheduled.set(write.filePath, {
      ...current,
      entry: current.entry.slice(write.entry.length),
    })
  }
}

function ensureParentDirectory(write: PendingWrite): void {
  const parent = dirname(write.filePath)
  if (parent && parent !== '.') {
    mkdirSync(parent, { recursive: true, mode: 0o700 })
  }
}

async function appendWrite(write: PendingWrite): Promise<void> {
  ensureParentDirectory(write)
  inFlight.set(write.filePath, write)
  try {
    await appendFile(write.filePath, write.entry, {
      encoding: 'utf8',
      mode: write.mode ?? 0o600,
    })
  } finally {
    if (inFlight.get(write.filePath) === write) {
      inFlight.delete(write.filePath)
    }
  }
}

function appendWriteSync(write: PendingWrite): void {
  ensureParentDirectory(write)
  appendFileSync(write.filePath, write.entry, {
    encoding: 'utf8',
    mode: write.mode ?? 0o600,
  })
}

/**
 * Append a JSONL line to a file without blocking the event loop.
 *
 * Writes to the same file are serialized in call order (a per-file promise
 * chain), and multiple lines to the same file are coalesced into a single
 * async append per tick. The directory is created eagerly so a queued append
 * can never fail on a missing parent.
 *
 * Data loss is avoided at process exit: a synchronous drain replays pending
 * and scheduled batches via `appendFileSync`.
 */
export function appendJsonlAsync(args: {
  filePath: string
  entry: string
  mode?: number
}): void {
  const { filePath, entry, mode } = args
  const previous = pending.get(filePath)
  pending.set(filePath, {
    filePath,
    entry: previous ? `${previous.entry}${entry}` : entry,
    mode,
  })

  // Create the parent directory eagerly so a queued append can never fail on
  // a missing parent and readers do not race with directory creation.
  try {
    ensureParentDirectory({ filePath, entry, mode })
  } catch {
    // The eventual write (or exit drain) reports any real failure.
  }

  if (flushTimer === null) {
    flushTimer = setTimeout(() => {
      flushTimer = null
      drainPending()
    }, 0)
    flushTimer.unref?.()
  }
}

function queueWrite(filePath: string, write?: PendingWrite): void {
  if (write) addScheduledWrite(write)
  const previous = queues.get(filePath) ?? Promise.resolve()
  // A rejected earlier append is deliberately retried before any later data
  // for this file. The recovery branch keeps the per-file chain usable while
  // `failed` retains the actual error state for explicit flushes and exit.
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const failedWrite = failed.get(filePath)
      if (failedWrite) {
        try {
          await appendWrite(failedWrite)
          removeScheduledWrite(failedWrite)
          failed.delete(filePath)
        } catch (error) {
          if (write) failed.set(filePath, mergeWrites(failedWrite, write))
          throw error
        }
      }
      if (!write) return
      try {
        await appendWrite(write)
        removeScheduledWrite(write)
      } catch (error) {
        failed.set(filePath, write)
        throw error
      }
    })
  queues.set(filePath, next)

  // Calls to appendJsonlAsync are intentionally fire-and-forget. Attach a
  // rejection handler so a reported failure does not become an unhandled
  // rejection, while preserving `next` for callers of flushJsonlWrites.
  void next.then(
    () => {
      if (queues.get(filePath) === next) queues.delete(filePath)
    },
    () => {
      if (queues.get(filePath) === next) queues.delete(filePath)
    },
  )
}

function drainPending(
  options: { retryFailures?: boolean; filePath?: string } = {},
): void {
  const writes = new Map(pending)
  if (options.filePath) pending.delete(options.filePath)
  else pending.clear()
  const filePaths = new Set(writes.keys())
  if (options.filePath) {
    filePaths.clear()
    if (writes.has(options.filePath)) filePaths.add(options.filePath)
  }
  if (options.retryFailures) {
    for (const filePath of failed.keys()) {
      if (!options.filePath || filePath === options.filePath) {
        filePaths.add(filePath)
      }
    }
  }
  for (const filePath of filePaths) {
    queueWrite(filePath, writes.get(filePath))
  }
}

let exitDrainRegistered = false

function drainSynchronouslyOnExit(): void {
  if (exitDrainRegistered) return
  exitDrainRegistered = true
  process.on('exit', () => {
    const writes = new Map(scheduled)
    for (const write of pending.values()) {
      const earlier = writes.get(write.filePath)
      writes.set(write.filePath, earlier ? mergeWrites(earlier, write) : write)
    }
    for (const write of writes.values()) {
      try {
        appendWriteSync(write)
      } catch {
        // Best effort: never block process termination.
      }
    }
    pending.clear()
    failed.clear()
    scheduled.clear()
    inFlight.clear()
  })
}

drainSynchronouslyOnExit()

/** Await all queued writes for a file (used by tests and controlled exits). */
export async function flushJsonlWrites(filePath?: string): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  drainPending({ retryFailures: true, filePath })
  const targets = filePath
    ? [queues.get(filePath)].filter(Boolean)
    : Array.from(queues.values())
  await Promise.all(targets as Promise<void>[])
}

/**
 * Synchronously flush lines that are still pending for a file. Read paths
 * call this before re-reading a JSONL file so a write-then-read sequence in
 * the same tick observes the appended lines.
 */
export function flushPendingSync(filePath?: string): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  const filePaths = filePath
    ? [filePath]
    : [...new Set([...pending.keys(), ...failed.keys()])]
  for (const path of filePaths) {
    const pendingWrite = pending.get(path)
    const failedWrite = failed.get(path)
    // Never overtake a running append with a synchronous write: doing so can
    // reverse JSONL order. The queued write will remain observable through
    // flushJsonlWrites, which is the controlled-shutdown API.
    if (inFlight.has(path) || queues.has(path)) {
      if (pendingWrite) {
        queueWrite(path, pendingWrite)
        pending.delete(path)
      }
      continue
    }
    if (failedWrite) {
      try {
        appendWriteSync(failedWrite)
        removeScheduledWrite(failedWrite)
        failed.delete(path)
      } catch {
        continue
      }
    }
    if (!pendingWrite) continue
    try {
      appendWriteSync(pendingWrite)
    } catch {
      addScheduledWrite(pendingWrite)
      failed.set(path, pendingWrite)
    } finally {
      pending.delete(path)
    }
  }
}
