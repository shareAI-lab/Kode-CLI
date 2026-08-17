import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

import { getKodeRoot } from '#config/dataRoots'

import {
  GOAL_SCHEMA_VERSION,
  MAX_GOAL_ACCEPTANCE_CRITERIA,
  MAX_GOAL_CONTINUATION_PROMPT_CHARS,
  MAX_GOAL_CONTINUATIONS,
  MAX_GOAL_CRITERION_CHARS,
  MAX_GOAL_ERROR_CODE_CHARS,
  MAX_GOAL_ID_CHARS,
  MAX_GOAL_OBJECTIVE_CHARS,
  MAX_GOAL_PROMPT_CHARS,
  MAX_GOAL_REASON_CHARS,
  type Goal,
  type GoalEvent,
  type GoalStatus,
  type GoalStorageOptions,
  type IntervalSchedule,
  type OnceSchedule,
  type Schedule,
} from './types'

const GOALS_DIRNAME = 'goals'
const GOAL_FILENAME = 'goal.json'
const EVENTS_FILENAME = 'events.jsonl'
const LOCK_FILENAME = '.lock'
const LOCK_STALE_MS = 30_000
const LOCK_RETRIES = 20
const LOCK_RETRY_DELAY_MS = 15

const GOAL_STATUSES = new Set<GoalStatus>([
  'scheduled',
  'running',
  'awaiting_approval',
  'paused',
  'completed',
  'failed',
  'cancelled',
])
const GOAL_EVENT_TYPES = new Set<GoalEvent['type']>([
  'created',
  'updated',
  'claimed',
  'continued',
  'released',
  'resumed',
  'retried',
  'run_requested',
  'completed',
  'paused',
  'failed',
  'cancelled',
  'approval_requested',
  'recovered',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function cleanStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  if (
    value.length > MAX_GOAL_ACCEPTANCE_CRITERIA ||
    value.some(
      item =>
        !isNonEmptyString(item) ||
        item.trim().length > MAX_GOAL_CRITERION_CHARS,
    )
  ) {
    return null
  }
  return value.map(item => item.trim())
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function sleepSync(ms: number): void {
  if (ms <= 0) return
  const buffer = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(buffer), 0, 0, ms)
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Cleanup is deliberately best effort. The original write error still wins.
  }
}

function safeMkdir(path: string): void {
  mkdirSync(path, { recursive: true })
}

function atomicWriteText(path: string, content: string): void {
  safeMkdir(dirname(path))
  const temporaryPath = `${path}.tmp.${process.pid}.${randomUUID()}`
  writeFileSync(temporaryPath, content, { encoding: 'utf8', mode: 0o600 })
  try {
    renameSync(temporaryPath, path)
  } catch (error) {
    // On Windows, rename-over-existing can fail despite a per-goal lock.
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    const canFallback = [
      'EPERM',
      'EACCES',
      'EEXIST',
      'ENOTEMPTY',
      'EBUSY',
    ].includes(String(code ?? ''))
    if (!canFallback) {
      safeUnlink(temporaryPath)
      throw error
    }
    try {
      writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 })
    } finally {
      safeUnlink(temporaryPath)
    }
  }
}

function parseLockOwnerPid(token: string): number | null {
  const pid = Number.parseInt(token.trim().split(/\s+/)[0] ?? '', 10)
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

/** Same-host liveness probe. `ESRCH` means the process is definitely gone. */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    // EPERM etc. mean the process exists but we cannot signal it: treat as
    // alive (fail closed) rather than risking a concurrent writer.
    return code !== 'ESRCH'
  }
}

/**
 * Returns the current lock token when the lock should be reclaimed, or null
 * when the waiter must keep waiting.
 *
 * A lock whose owner PID is gone can be reclaimed immediately — a dead
 * process can never write again, so there is no corruption risk. A lock
 * whose owner is a live process is never evicted on mtime alone: evicting a
 * slow-but-alive writer would let two writers run concurrently and corrupt
 * the goal store. Only tokens without a parseable PID (legacy/foreign)
 * fall back to the mtime timeout.
 */
function inspectStaleLock(lockPath: string): string | null {
  let token: string
  try {
    token = readFileSync(lockPath, 'utf8')
  } catch {
    // Released between exists/stat and this read; retry acquisition.
    return null
  }
  const pid = parseLockOwnerPid(token)
  if (pid !== null && !processIsAlive(pid)) return token
  if (pid !== null) return null
  try {
    if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) return token
  } catch {
    return null
  }
  return null
}

function acquireLock(lockPath: string): () => void {
  safeMkdir(dirname(lockPath))
  const lockToken = `${process.pid} ${randomUUID()} ${Date.now()}\n`
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    try {
      const descriptor = openSync(lockPath, 'wx', 0o600)
      try {
        writeFileSync(descriptor, lockToken, 'utf8')
      } finally {
        closeSync(descriptor)
      }
      return () => {
        // Only remove the lock while it is still ours; a competitor may have
        // declared it stale and taken over during a long write.
        try {
          if (readFileSync(lockPath, 'utf8') === lockToken) {
            safeUnlink(lockPath)
          }
        } catch {
          // The lock was already removed by a competitor or owner.
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code !== 'EEXIST') throw error
      const inspected = inspectStaleLock(lockPath)
      if (inspected !== null) {
        // Unlink only if the lock still carries the exact token we inspected;
        // a competitor may have released and re-acquired it in the meantime.
        try {
          if (readFileSync(lockPath, 'utf8') === inspected) {
            safeUnlink(lockPath)
            continue
          }
        } catch {
          // Released before we could unlink; retry acquisition.
        }
      }
      sleepSync(LOCK_RETRY_DELAY_MS)
    }
  }
  throw new Error(`Failed to acquire goal store lock: ${lockPath}`)
}

function parseSchedule(value: unknown): Schedule | null {
  if (!isRecord(value)) return null
  const commonValid =
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.goalId) &&
    isNonEmptyString(value.cwd) &&
    isNonEmptyString(value.sessionId) &&
    isNonEmptyString(value.prompt) &&
    value.prompt.trim().length <= MAX_GOAL_PROMPT_CHARS &&
    (value.nextRunAt === null ||
      (isSafeInteger(value.nextRunAt) && value.nextRunAt >= 0)) &&
    (value.retryAt === undefined ||
      (isSafeInteger(value.retryAt) && value.retryAt >= 0)) &&
    (value.lastClaimedAt === undefined ||
      (isSafeInteger(value.lastClaimedAt) && value.lastClaimedAt >= 0))
  if (!commonValid) return null

  const base = {
    id: String(value.id).trim(),
    goalId: String(value.goalId).trim(),
    cwd: String(value.cwd).trim(),
    sessionId: String(value.sessionId).trim(),
    prompt: String(value.prompt).trim(),
    nextRunAt: value.nextRunAt as number | null,
    ...(isSafeInteger(value.retryAt) ? { retryAt: value.retryAt } : {}),
    ...(isSafeInteger(value.lastClaimedAt)
      ? { lastClaimedAt: value.lastClaimedAt }
      : {}),
  }

  if (value.kind === 'once' && isSafeInteger(value.runAt) && value.runAt >= 0) {
    return { ...base, kind: 'once', runAt: value.runAt } satisfies OnceSchedule
  }
  if (
    value.kind === 'interval' &&
    isSafeInteger(value.everyMs) &&
    value.everyMs > 0 &&
    isSafeInteger(value.anchorAt) &&
    value.anchorAt >= 0
  ) {
    return {
      ...base,
      kind: 'interval',
      everyMs: value.everyMs,
      anchorAt: value.anchorAt,
    } satisfies IntervalSchedule
  }
  return null
}

function parseGoal(value: unknown): Goal | null {
  if (!isRecord(value)) return null
  if (value.schemaVersion !== GOAL_SCHEMA_VERSION) return null
  if (
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.cwd) ||
    !isNonEmptyString(value.sessionId) ||
    !isNonEmptyString(value.objective) ||
    value.id.trim().length > MAX_GOAL_ID_CHARS ||
    value.objective.trim().length > MAX_GOAL_OBJECTIVE_CHARS ||
    !GOAL_STATUSES.has(value.status as GoalStatus) ||
    !isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !isSafeInteger(value.createdAt) ||
    value.createdAt < 0 ||
    !isSafeInteger(value.updatedAt) ||
    value.updatedAt < 0
  ) {
    return null
  }

  const acceptanceCriteria = cleanStringArray(value.acceptanceCriteria)
  const schedule = parseSchedule(value.schedule)
  if (!acceptanceCriteria || !schedule || schedule.goalId !== value.id.trim()) {
    return null
  }

  const loopRecord = isRecord(value.loop) ? value.loop : null
  if (
    !loopRecord ||
    !isSafeInteger(loopRecord.maxIterations) ||
    loopRecord.maxIterations < 1 ||
    loopRecord.maxIterations > MAX_GOAL_CONTINUATIONS ||
    !isNonEmptyString(loopRecord.continuationPrompt) ||
    loopRecord.continuationPrompt.trim().length >
      MAX_GOAL_CONTINUATION_PROMPT_CHARS
  ) {
    return null
  }

  const goal: Goal = {
    schemaVersion: GOAL_SCHEMA_VERSION,
    id: value.id.trim(),
    cwd: value.cwd.trim(),
    sessionId: value.sessionId.trim(),
    objective: value.objective.trim(),
    acceptanceCriteria,
    status: value.status as GoalStatus,
    schedule,
    loop: {
      maxIterations: loopRecord.maxIterations,
      continuationPrompt: loopRecord.continuationPrompt.trim(),
    },
    revision: value.revision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }

  if (value.completedAt !== undefined) {
    if (!isSafeInteger(value.completedAt) || value.completedAt < 0) return null
    goal.completedAt = value.completedAt
  }
  if (value.pausedReason !== undefined) {
    if (
      !isNonEmptyString(value.pausedReason) ||
      value.pausedReason.trim().length > MAX_GOAL_REASON_CHARS
    ) {
      return null
    }
    goal.pausedReason = value.pausedReason.trim()
  }
  if (value.lastError !== undefined) {
    if (
      !isRecord(value.lastError) ||
      !(
        isNonEmptyString(value.lastError.code) &&
        value.lastError.code.trim().length <= MAX_GOAL_ERROR_CODE_CHARS &&
        isNonEmptyString(value.lastError.message) &&
        value.lastError.message.trim().length <= MAX_GOAL_REASON_CHARS &&
        isSafeInteger(value.lastError.at) &&
        value.lastError.at >= 0
      )
    ) {
      return null
    }
    goal.lastError = {
      code: value.lastError.code.trim(),
      message: value.lastError.message.trim(),
      at: value.lastError.at,
    }
  }
  if (value.lease !== undefined) {
    if (
      !isRecord(value.lease) ||
      !(
        isNonEmptyString(value.lease.ownerId) &&
        isNonEmptyString(value.lease.runId) &&
        isSafeInteger(value.lease.acquiredAt) &&
        value.lease.acquiredAt >= 0 &&
        isSafeInteger(value.lease.expiresAt) &&
        value.lease.expiresAt > value.lease.acquiredAt
      )
    ) {
      return null
    }
    goal.lease = {
      ownerId: value.lease.ownerId.trim(),
      runId: value.lease.runId.trim(),
      acquiredAt: value.lease.acquiredAt,
      expiresAt: value.lease.expiresAt,
    }
  }
  if (value.activeRun !== undefined) {
    if (
      !isRecord(value.activeRun) ||
      !(
        isNonEmptyString(value.activeRun.id) &&
        isNonEmptyString(value.activeRun.scheduleId) &&
        isSafeInteger(value.activeRun.scheduledFor) &&
        value.activeRun.scheduledFor >= 0 &&
        isSafeInteger(value.activeRun.startedAt) &&
        value.activeRun.startedAt >= 0 &&
        isSafeInteger(value.activeRun.turnCount) &&
        value.activeRun.turnCount >= 0 &&
        value.activeRun.turnCount <= goal.loop.maxIterations
      )
    ) {
      return null
    }
    goal.activeRun = {
      id: value.activeRun.id.trim(),
      scheduleId: value.activeRun.scheduleId.trim(),
      scheduledFor: value.activeRun.scheduledFor,
      startedAt: value.activeRun.startedAt,
      turnCount: value.activeRun.turnCount,
    }
  }
  if (value.metadata !== undefined) {
    if (!isRecord(value.metadata)) return null
    goal.metadata = clone(value.metadata)
  }

  if (
    schedule.cwd !== goal.cwd ||
    schedule.sessionId !== goal.sessionId ||
    (goal.activeRun !== undefined &&
      goal.activeRun.scheduleId !== schedule.id) ||
    (goal.lease && goal.activeRun?.id !== goal.lease.runId)
  ) {
    return null
  }
  if (goal.status === 'running' && (!goal.lease || !goal.activeRun)) {
    return null
  }
  if (
    goal.status === 'awaiting_approval' &&
    (goal.lease !== undefined || !goal.activeRun)
  ) {
    return null
  }
  if (
    goal.status !== 'running' &&
    goal.status !== 'awaiting_approval' &&
    (goal.lease !== undefined || goal.activeRun !== undefined)
  ) {
    return null
  }

  return goal
}

function parseGoalEvent(value: unknown): GoalEvent | null {
  if (!isRecord(value)) return null
  if (
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.goalId) ||
    !isNonEmptyString(value.type) ||
    !GOAL_EVENT_TYPES.has(value.type as GoalEvent['type']) ||
    !isSafeInteger(value.at) ||
    value.at < 0 ||
    !isSafeInteger(value.revision) ||
    value.revision < 1 ||
    (value.from !== undefined &&
      !GOAL_STATUSES.has(value.from as GoalStatus)) ||
    (value.to !== undefined && !GOAL_STATUSES.has(value.to as GoalStatus)) ||
    (value.message !== undefined &&
      (!isNonEmptyString(value.message) ||
        value.message.trim().length > MAX_GOAL_REASON_CHARS)) ||
    (value.data !== undefined && !isRecord(value.data))
  ) {
    return null
  }
  const event: GoalEvent = {
    id: value.id.trim(),
    goalId: value.goalId.trim(),
    type: value.type as GoalEvent['type'],
    at: value.at,
    revision: value.revision,
  }
  if (isNonEmptyString(value.from)) event.from = value.from as GoalStatus
  if (isNonEmptyString(value.to)) event.to = value.to as GoalStatus
  if (isNonEmptyString(value.message)) {
    event.message = value.message.trim()
  }
  if (isRecord(value.data)) event.data = clone(value.data)
  return event
}

function parseGoalEventsText(value: string): GoalEvent[] {
  return value
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap(line => {
      try {
        const event = parseGoalEvent(JSON.parse(line))
        return event ? [event] : []
      } catch {
        return []
      }
    })
}

export function sanitizeGoalId(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]/g, '-')
}

export class GoalStorage {
  private readonly rootDir: string
  // Every mutating path touches the goals directory mtime so listGoals can
  // serve a cached snapshot across processes without re-reading every file.
  private listCache: { dirMtimeMs: number; goals: Goal[] } | null = null

  constructor(options: GoalStorageOptions = {}) {
    this.rootDir = options.rootDir?.trim() || getKodeRoot()
  }

  getGoalsDir(): string {
    return join(this.rootDir, GOALS_DIRNAME)
  }

  getGoalDir(goalId: string): string {
    return join(this.getGoalsDir(), sanitizeGoalId(goalId))
  }

  getGoalFilePath(goalId: string): string {
    return join(this.getGoalDir(goalId), GOAL_FILENAME)
  }

  getEventsFilePath(goalId: string): string {
    return join(this.getGoalDir(goalId), EVENTS_FILENAME)
  }

  private getLockFilePath(goalId: string): string {
    return join(this.getGoalDir(goalId), LOCK_FILENAME)
  }

  private getScopeLockFilePath(cwd: string, sessionId: string): string {
    const key = createHash('sha256')
      .update(`${cwd}\0${sessionId}`)
      .digest('hex')
      .slice(0, 24)
    return join(this.getGoalsDir(), `.scope-${key}.lock`)
  }

  private withGoalLock<T>(goalId: string, operation: () => T): T {
    const release = acquireLock(this.getLockFilePath(goalId))
    try {
      return operation()
    } finally {
      release()
    }
  }

  /**
   * Serializes claims and direct starts for one workspace/session across
   * processes. Per-goal locks cannot enforce the one-active-run invariant.
   */
  withScopeLock<T>(
    args: { cwd: string; sessionId: string },
    operation: () => T,
  ): T {
    const release = acquireLock(
      this.getScopeLockFilePath(args.cwd, args.sessionId),
    )
    try {
      return operation()
    } finally {
      release()
    }
  }

  private readGoalUnsafe(goalId: string): Goal | null {
    const path = this.getGoalFilePath(goalId)
    if (!existsSync(path)) return null
    try {
      return parseGoal(JSON.parse(readFileSync(path, 'utf8')))
    } catch {
      return null
    }
  }

  getGoal(goalId: string): Goal | null {
    const goal = this.readGoalUnsafe(goalId)
    return goal ? clone(goal) : null
  }

  listGoals(): Goal[] {
    const dir = this.getGoalsDir()
    if (!existsSync(dir)) {
      this.listCache = null
      return []
    }
    let dirMtimeMs: number
    try {
      dirMtimeMs = statSync(dir).mtimeMs
    } catch {
      this.listCache = null
      return []
    }
    if (this.listCache && this.listCache.dirMtimeMs === dirMtimeMs) {
      return this.listCache.goals.map(clone)
    }
    const goals: Goal[] = []
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      if (!name.isDirectory() || name.name.startsWith('.')) continue
      const goal = this.readGoalUnsafe(name.name)
      if (goal) goals.push(goal)
    }
    goals.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    this.listCache = { dirMtimeMs, goals: goals.map(clone) }
    return goals
  }

  /** Marks the goal directory as changed so other processes re-read. */
  private touchGoalsDir(): void {
    this.listCache = null
    const dir = this.getGoalsDir()
    try {
      if (existsSync(dir)) {
        // Some filesystems coalesce two writes in the same clock tick. Move
        // mtime forward monotonically so another GoalStorage instance never
        // accepts an old snapshot after a cross-process mutation.
        const currentMtimeMs = statSync(dir).mtimeMs
        const nextMtimeMs = Math.max(Date.now(), Math.ceil(currentMtimeMs) + 1)
        const now = new Date(nextMtimeMs)
        utimesSync(dir, now, now)
      }
    } catch {
      // Best-effort: stale reads are safe, just less fresh.
    }
  }

  createGoal(goal: Goal): Goal {
    const sanitizedId = sanitizeGoalId(goal.id)
    if (!sanitizedId) throw new Error('Goal ID cannot be empty.')
    return this.withGoalLock(sanitizedId, () => {
      if (this.readGoalUnsafe(sanitizedId)) {
        throw new Error(`Goal already exists: ${sanitizedId}`)
      }
      const normalized = clone({ ...goal, id: sanitizedId })
      normalized.schedule.goalId = sanitizedId
      atomicWriteText(
        this.getGoalFilePath(sanitizedId),
        JSON.stringify(normalized, null, 2),
      )
      this.touchGoalsDir()
      return clone(normalized)
    })
  }

  /**
   * Serializes read-modify-write for one goal across processes. Returning null
   * from the mutator means "leave the current record unchanged".
   */
  mutateGoal<T>(
    goalId: string,
    mutator: (current: Goal) => { goal: Goal; result: T } | null,
  ): { before: Goal; goal: Goal; result: T } | null {
    const sanitizedId = sanitizeGoalId(goalId)
    if (!sanitizedId) return null
    return this.withGoalLock(sanitizedId, () => {
      const current = this.readGoalUnsafe(sanitizedId)
      if (!current) return null
      const mutation = mutator(clone(current))
      if (!mutation) return null
      const next = clone({ ...mutation.goal, id: sanitizedId })
      next.schedule.goalId = sanitizedId
      atomicWriteText(
        this.getGoalFilePath(sanitizedId),
        JSON.stringify(next, null, 2),
      )
      this.touchGoalsDir()
      return {
        before: clone(current),
        goal: clone(next),
        result: mutation.result,
      }
    })
  }

  appendEvent(event: GoalEvent): void {
    const goalId = sanitizeGoalId(event.goalId)
    if (!goalId) throw new Error('Goal event is missing goalId.')
    this.withGoalLock(goalId, () => {
      const eventPath = this.getEventsFilePath(goalId)
      safeMkdir(dirname(eventPath))
      appendFileSync(eventPath, JSON.stringify(event) + '\n', {
        encoding: 'utf8',
        mode: 0o600,
      })
    })
  }

  listEvents(goalId: string, options: { limit?: number } = {}): GoalEvent[] {
    const path = this.getEventsFilePath(goalId)
    if (!existsSync(path)) return []
    const limit = options.limit
    if (
      limit !== undefined &&
      (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
    ) {
      throw new Error('Goal event limit must be an integer between 1 and 1000.')
    }
    try {
      if (limit === undefined) {
        return parseGoalEventsText(readFileSync(path, 'utf8'))
      }

      // Read backwards in bounded chunks until enough complete JSONL records
      // are available. Schedule histories can grow indefinitely, so the Web
      // control plane must not read the whole journal for every expansion.
      const descriptor = openSync(path, 'r')
      try {
        const fileSize = fstatSync(descriptor).size
        const chunks: Buffer[] = []
        let position = fileSize
        let lineBreaks = 0
        while (position > 0 && lineBreaks <= limit) {
          const size = Math.min(64 * 1024, position)
          position -= size
          const chunk = Buffer.allocUnsafe(size)
          const bytesRead = readSync(descriptor, chunk, 0, size, position)
          const selected =
            bytesRead === size ? chunk : chunk.subarray(0, bytesRead)
          for (const byte of selected) {
            if (byte === 0x0a) lineBreaks += 1
          }
          chunks.unshift(selected)
        }
        let raw = Buffer.concat(chunks).toString('utf8')
        if (position > 0) {
          const firstCompleteLine = raw.indexOf('\n')
          raw = firstCompleteLine >= 0 ? raw.slice(firstCompleteLine + 1) : ''
        }
        return parseGoalEventsText(raw).slice(-limit)
      } finally {
        closeSync(descriptor)
      }
    } catch {
      return []
    }
  }
}
