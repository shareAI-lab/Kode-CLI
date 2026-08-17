import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

import { getKodeRoot } from '#config/dataRoots'

export type WorkspaceLeaseMode = 'read' | 'write'

export type WorkspaceLease = {
  workspacePath: string
  mode: WorkspaceLeaseMode
  release(): Promise<void>
}

export type AcquireWorkspaceLeaseOptions = {
  workspacePath: string
  mode: WorkspaceLeaseMode
  signal?: AbortSignal
}

export type WorkspaceLeaseManagerOptions = {
  /** Overrides the Kode data root; intended for isolated tests and hosts. */
  leaseRoot?: string
}

export type WorkspaceLeaseManager = {
  acquire(options: AcquireWorkspaceLeaseOptions): Promise<WorkspaceLease>
}

const LEASES_DIRNAME = 'workspace-leases'
const READERS_DIRNAME = 'readers'
const GATE_FILENAME = '.gate'
const WRITER_FILENAME = 'writer.lock'
const RETRY_DELAY_MS = 25
const HEARTBEAT_INTERVAL_MS = 2_000
const STALE_LEASE_MS = 20_000

type LocalWaiter = {
  mode: WorkspaceLeaseMode
  resolve: (release: () => void) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  onAbort?: () => void
}

type LocalLeaseState = {
  readers: number
  writer: boolean
  waiters: LocalWaiter[]
}

type FileLease = {
  release(): Promise<void>
}

function abortError(): Error {
  const error = new Error('Workspace lease acquisition was cancelled.')
  error.name = 'AbortError'
  return error
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST'
}

function normalizeWorkspacePath(workspacePath: string): string {
  const absolute = resolve(workspacePath)
  let canonical = absolute
  try {
    canonical = realpathSync.native(absolute)
  } catch {
    // A caller may be preparing a workspace that has not been created yet.
    // Resolve is still stable enough to keep local callers serialized.
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

export function canonicalizeWorkspacePath(workspacePath: string): string {
  const clean = workspacePath.trim()
  if (!clean) throw new Error('Workspace lease requires a non-empty path.')
  return normalizeWorkspacePath(clean)
}

function leaseDirectory(leaseRoot: string, workspacePath: string): string {
  const workspaceKey = createHash('sha256').update(workspacePath).digest('hex')
  return join(resolve(leaseRoot), LEASES_DIRNAME, workspaceKey)
}

function sleep(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolvePromise()
    }, RETRY_DELAY_MS)
    timer.unref?.()
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Another owner may have completed between a state check and cleanup.
  }
}

function isProcessAlive(pid: number): boolean | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ESRCH') return false
    return null
  }
}

function isStaleLease(path: string): boolean {
  try {
    const stat = statSync(path)
    if (Date.now() - stat.mtimeMs <= STALE_LEASE_MS) return false
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown }
    const alive =
      typeof parsed.pid === 'number' ? isProcessAlive(parsed.pid) : null
    return alive !== true
  } catch {
    // A malformed or disappeared lock must not permanently block a workspace.
    return true
  }
}

function removeStaleLeases(directory: string): void {
  const writerPath = join(directory, WRITER_FILENAME)
  if (isStaleLease(writerPath)) safeUnlink(writerPath)

  const readersDirectory = join(directory, READERS_DIRNAME)
  let readers: string[] = []
  try {
    readers = readdirSync(readersDirectory)
  } catch {
    return
  }
  for (const reader of readers) {
    const readerPath = join(readersDirectory, reader)
    if (isStaleLease(readerPath)) safeUnlink(readerPath)
  }
}

function tryAcquireGate(
  directory: string,
): { path: string; token: string } | null {
  const path = join(directory, GATE_FILENAME)
  const token = JSON.stringify({ pid: process.pid, token: randomUUID() })
  try {
    const fd = openSync(path, 'wx', 0o600)
    try {
      writeFileSync(fd, token, 'utf8')
    } finally {
      closeSync(fd)
    }
    return { path, token }
  } catch (error) {
    if (!isAlreadyExists(error)) throw error
    if (isStaleLease(path)) safeUnlink(path)
    return null
  }
}

function releaseOwnedFile(path: string, token: string): void {
  try {
    if (readFileSync(path, 'utf8') === token) safeUnlink(path)
  } catch {
    // The record was already removed or replaced after becoming stale.
  }
}

function releaseGate(gate: { path: string; token: string }): void {
  releaseOwnedFile(gate.path, gate.token)
}

function hasReaders(directory: string): boolean {
  try {
    return readdirSync(join(directory, READERS_DIRNAME)).length > 0
  } catch {
    return false
  }
}

function createLeaseRecord(): string {
  return JSON.stringify({ pid: process.pid, token: randomUUID() })
}

function startLeaseHeartbeat(path: string, token: string): () => void {
  const timer = setInterval(() => {
    try {
      if (readFileSync(path, 'utf8') !== token) {
        clearInterval(timer)
        return
      }
      const now = new Date()
      utimesSync(path, now, now)
    } catch {
      clearInterval(timer)
    }
  }, HEARTBEAT_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}

async function releaseFileLease(args: {
  directory: string
  recordPath: string
  token: string
  stopHeartbeat: () => void
}): Promise<void> {
  args.stopHeartbeat()
  while (true) {
    const gate = tryAcquireGate(args.directory)
    if (gate) {
      try {
        releaseOwnedFile(args.recordPath, args.token)
      } finally {
        releaseGate(gate)
      }
      return
    }
    await sleep()
  }
}

function tryAcquireFileLease(args: {
  directory: string
  mode: WorkspaceLeaseMode
}): FileLease | null {
  mkdirSync(join(args.directory, READERS_DIRNAME), {
    recursive: true,
    mode: 0o700,
  })
  const gate = tryAcquireGate(args.directory)
  if (!gate) return null

  try {
    removeStaleLeases(args.directory)
    const writerPath = join(args.directory, WRITER_FILENAME)
    if (args.mode === 'write') {
      if (statExists(writerPath) || hasReaders(args.directory)) return null
      const token = createLeaseRecord()
      writeFileSync(writerPath, token, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      })
      const stopHeartbeat = startLeaseHeartbeat(writerPath, token)
      return {
        release: () =>
          releaseFileLease({
            directory: args.directory,
            recordPath: writerPath,
            token,
            stopHeartbeat,
          }),
      }
    }

    if (statExists(writerPath)) return null
    const readerPath = join(
      args.directory,
      READERS_DIRNAME,
      `reader-${process.pid}-${randomUUID()}.lock`,
    )
    const token = createLeaseRecord()
    writeFileSync(readerPath, token, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
    const stopHeartbeat = startLeaseHeartbeat(readerPath, token)
    return {
      release: () =>
        releaseFileLease({
          directory: args.directory,
          recordPath: readerPath,
          token,
          stopHeartbeat,
        }),
    }
  } finally {
    releaseGate(gate)
  }
}

function statExists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

async function acquireFileLease(args: {
  directory: string
  mode: WorkspaceLeaseMode
  signal?: AbortSignal
}): Promise<FileLease> {
  while (true) {
    if (args.signal?.aborted) throw abortError()
    const lease = tryAcquireFileLease(args)
    if (lease) return lease
    await sleep(args.signal)
  }
}

function acquireLocalLease(args: {
  states: Map<string, LocalLeaseState>
  workspacePath: string
  mode: WorkspaceLeaseMode
  signal?: AbortSignal
}): Promise<() => void> {
  if (args.signal?.aborted) return Promise.reject(abortError())
  const state = args.states.get(args.workspacePath) ?? {
    readers: 0,
    writer: false,
    waiters: [],
  }
  args.states.set(args.workspacePath, state)

  const drain = () => {
    if (state.writer || state.waiters.length === 0) return
    const next = state.waiters[0]!
    if (next.mode === 'write') {
      if (state.readers > 0) return
      state.waiters.shift()
      state.writer = true
      grantLocalLease(args.states, args.workspacePath, state, next, drain)
      return
    }
    while (state.waiters[0]?.mode === 'read' && !state.writer) {
      const reader = state.waiters.shift()!
      state.readers += 1
      grantLocalLease(args.states, args.workspacePath, state, reader, drain)
    }
  }

  return new Promise((resolvePromise, reject) => {
    const waiter: LocalWaiter = {
      mode: args.mode,
      resolve: resolvePromise,
      reject,
      signal: args.signal,
    }
    waiter.onAbort = () => {
      const index = state.waiters.indexOf(waiter)
      if (index >= 0) state.waiters.splice(index, 1)
      waiter.reject(abortError())
      drain()
    }
    args.signal?.addEventListener('abort', waiter.onAbort, { once: true })
    state.waiters.push(waiter)
    drain()
  })
}

function grantLocalLease(
  states: Map<string, LocalLeaseState>,
  workspacePath: string,
  state: LocalLeaseState,
  waiter: LocalWaiter,
  drain: () => void,
): void {
  if (waiter.onAbort)
    waiter.signal?.removeEventListener('abort', waiter.onAbort)
  let released = false
  waiter.resolve(() => {
    if (released) return
    released = true
    if (waiter.mode === 'write') state.writer = false
    else state.readers -= 1
    drain()
    if (!state.writer && state.readers === 0 && state.waiters.length === 0) {
      states.delete(workspacePath)
    }
  })
}

export function createWorkspaceLeaseManager(
  managerOptions: WorkspaceLeaseManagerOptions = {},
): WorkspaceLeaseManager {
  const states = new Map<string, LocalLeaseState>()
  return {
    async acquire(
      options: AcquireWorkspaceLeaseOptions,
    ): Promise<WorkspaceLease> {
      const workspacePath = canonicalizeWorkspacePath(options.workspacePath)
      const releaseLocal = await acquireLocalLease({
        states,
        workspacePath,
        mode: options.mode,
        signal: options.signal,
      })
      try {
        const fileLease = await acquireFileLease({
          directory: leaseDirectory(
            managerOptions.leaseRoot ?? getKodeRoot(),
            workspacePath,
          ),
          mode: options.mode,
          signal: options.signal,
        })
        let released = false
        return {
          workspacePath,
          mode: options.mode,
          async release(): Promise<void> {
            if (released) return
            released = true
            try {
              await fileLease.release()
            } finally {
              releaseLocal()
            }
          },
        }
      } catch (error) {
        releaseLocal()
        throw error
      }
    },
  }
}

const defaultWorkspaceLeaseManager = createWorkspaceLeaseManager()

export function acquireWorkspaceLease(
  options: AcquireWorkspaceLeaseOptions,
): Promise<WorkspaceLease> {
  return defaultWorkspaceLeaseManager.acquire(options)
}
