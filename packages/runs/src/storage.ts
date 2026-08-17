import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { getKodeRoot } from '#config/dataRoots'
import type { DurableRun } from './types'

function safeId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(value))
    throw new Error('Invalid durable run id.')
  return value
}

export function createDurableRunId(): string {
  return `run-${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

export function getDurableRunStorageRoot(storageRoot?: string): string {
  return resolve(storageRoot ?? join(getKodeRoot(), 'runs'))
}

export function getDurableRunPath(args: {
  id: string
  storageRoot?: string
}): string {
  return join(
    getDurableRunStorageRoot(args.storageRoot),
    `${safeId(args.id)}.json`,
  )
}

function writeAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  const content = JSON.stringify(value, null, 2)
  writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 })
  try {
    renameSync(temp, path)
  } catch (error) {
    // A destination that is briefly held open can make an overwrite-rename
    // fail on Windows. Keep the old record intact when possible; only use the
    // direct-write fallback for those known platform contention errors.
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    const canFallback = [
      'EPERM',
      'EACCES',
      'EEXIST',
      'ENOTEMPTY',
      'EBUSY',
    ].includes(String(code ?? ''))
    if (!canFallback) {
      try {
        unlinkSync(temp)
      } catch {
        /* no-op */
      }
      throw error
    }
    try {
      writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 })
    } finally {
      try {
        unlinkSync(temp)
      } catch {
        /* no-op */
      }
    }
  }
}

const LOCK_STALE_MS = 10_000

function acquireRunStoreLock(storageRoot: string | undefined): () => void {
  const root = getDurableRunStorageRoot(storageRoot)
  mkdirSync(root, { recursive: true })
  const lockPath = join(root, '.lock')
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600)
      try {
        writeFileSync(fd, `${process.pid} ${Date.now()}\n`, 'utf8')
      } finally {
        closeSync(fd)
      }
      return () => {
        try {
          unlinkSync(lockPath)
        } catch {
          /* no-op */
        }
      }
    } catch {
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockPath)
          continue
        }
      } catch {
        /* no-op */
      }
      const memory = new Int32Array(new SharedArrayBuffer(4))
      Atomics.wait(memory, 0, 0, 20)
    }
  }
  throw new Error('Failed to acquire durable run store lock.')
}

function withRunStoreLock<T>(
  storageRoot: string | undefined,
  action: () => T,
): T {
  const release = acquireRunStoreLock(storageRoot)
  try {
    return action()
  } finally {
    release()
  }
}

function writeDurableRunUnlocked(
  run: DurableRun,
  storageRoot?: string,
): DurableRun {
  writeAtomic(getDurableRunPath({ id: run.id, storageRoot }), run)
  return run
}

export function writeDurableRun(
  run: DurableRun,
  storageRoot?: string,
): DurableRun {
  return withRunStoreLock(storageRoot, () =>
    writeDurableRunUnlocked(run, storageRoot),
  )
}

export function readDurableRun(args: {
  id: string
  storageRoot?: string
}): DurableRun | null {
  const path = getDurableRunPath(args)
  if (!existsSync(path)) return null
  try {
    const run = JSON.parse(readFileSync(path, 'utf8')) as DurableRun
    if (!run || run.version !== 1 || run.id !== args.id) return null
    return run
  } catch {
    return null
  }
}

export function listDurableRuns(storageRoot?: string): DurableRun[] {
  const root = getDurableRunStorageRoot(storageRoot)
  try {
    return readdirSync(root)
      .filter(name => name.endsWith('.json'))
      .flatMap(name => {
        const run = readDurableRun({ id: name.slice(0, -5), storageRoot })
        return run ? [run] : []
      })
      .sort((a, b) => a.createdAt - b.createdAt)
  } catch {
    return []
  }
}

export function mutateDurableRun(args: {
  id: string
  storageRoot?: string
  mutate: (current: DurableRun | null) => DurableRun | null
}): DurableRun | null {
  return withRunStoreLock(args.storageRoot, () => {
    const current = readDurableRun({
      id: args.id,
      storageRoot: args.storageRoot,
    })
    const next = args.mutate(current)
    return next ? writeDurableRunUnlocked(next, args.storageRoot) : null
  })
}
