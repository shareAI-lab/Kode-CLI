import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import { appendGoalEvent } from './events'
import { GoalStorage } from './storage'
import {
  GOAL_SCHEMA_VERSION,
  systemClock,
  type ClaimDueSchedulesInput,
  type ClaimedSchedule,
  type Clock,
  type ControlPlaneGoalScheduleTransitionInput,
  type ControlPlaneGoalScheduleTransitionResult,
  type CreateGoalInput,
  type CreateScheduledGoalControlPlaneInput,
  type Goal,
  type GoalLease,
  type GoalServiceOptions,
  type GoalStatus,
  type GoalTurnEvaluation,
  type GoalTurnEvaluationResult,
  type GoalTurnEvaluator,
  type RecoverInterruptedGoalsInput,
  type Schedule,
  type ScheduleInput,
} from './types'

const DEFAULT_LEASE_DURATION_MS = 10 * 60 * 1000
const DEFAULT_MAX_ITERATIONS = 8
const DEFAULT_CONTINUATION_PROMPT =
  'Continue working toward the active goal. Re-check every acceptance criterion and collect concrete evidence before declaring completion.'

const TRANSITIONS: Record<GoalStatus, ReadonlySet<GoalStatus>> = {
  scheduled: new Set(['running', 'paused', 'cancelled']),
  running: new Set([
    'scheduled',
    'awaiting_approval',
    'paused',
    'completed',
    'failed',
    'cancelled',
  ]),
  awaiting_approval: new Set(['scheduled', 'paused', 'cancelled']),
  paused: new Set(['scheduled', 'cancelled']),
  completed: new Set(['scheduled', 'cancelled']),
  failed: new Set(['scheduled', 'paused', 'cancelled']),
  cancelled: new Set(),
}

function cleanText(value: string, name: string): string {
  const text = String(value ?? '').trim()
  if (!text) throw new Error(`${name} cannot be empty.`)
  return text
}

function cleanCriteria(values: string[] | undefined): string[] {
  return (values ?? []).map(value => String(value).trim()).filter(Boolean)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function normaliseLeaseDuration(value: number | undefined): number {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) {
    return DEFAULT_LEASE_DURATION_MS
  }
  return Math.max(1_000, Math.floor(value!))
}

function dueAt(schedule: Schedule): number | null {
  if (typeof schedule.retryAt === 'number') return schedule.retryAt
  return schedule.nextRunAt
}

/** Return the first fixed slot strictly after now; do not replay missed slots. */
function nextFixedIntervalAt(
  scheduledAt: number,
  everyMs: number,
  now: number,
): number {
  const firstNext = scheduledAt + everyMs
  if (firstNext > now) return firstNext
  const skipped = Math.floor((now - scheduledAt) / everyMs) + 1
  return scheduledAt + skipped * everyMs
}

function transitionAllowed(from: GoalStatus, to: GoalStatus): boolean {
  return TRANSITIONS[from].has(to)
}

function extractTextContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .flatMap(block => {
      if (!block || typeof block !== 'object') return []
      const record = block as Record<string, unknown>
      return record.type === 'text' && typeof record.text === 'string'
        ? [record.text]
        : []
    })
    .join('\n')
}

function parseEvaluationText(text: string): GoalTurnEvaluation | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const candidates = [trimmed]
  const objectMatch = trimmed.match(/\{[\s\S]*\}/)
  if (objectMatch?.[0] && objectMatch[0] !== trimmed) {
    candidates.push(objectMatch[0])
  }
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate) as Record<string, unknown>
      const action = value.action
      if (
        action !== 'continue' &&
        action !== 'complete' &&
        action !== 'paused' &&
        action !== 'none'
      ) {
        continue
      }
      return {
        action,
        ...(typeof value.reason === 'string' && value.reason.trim()
          ? { reason: value.reason.trim() }
          : {}),
        ...(typeof value.continuationPrompt === 'string' &&
        value.continuationPrompt.trim()
          ? { continuationPrompt: value.continuationPrompt.trim() }
          : {}),
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

export async function defaultGoalTurnEvaluator(
  input: Parameters<GoalTurnEvaluator>[0],
): Promise<GoalTurnEvaluation> {
  if (input.signal?.aborted) {
    return { action: 'paused', reason: 'Goal evaluation was aborted.' }
  }

  const { queryQuick } = await import('#core/ai/llmLazy')
  const response = await queryQuick({
    signal: input.signal,
    systemPrompt: [
      'You are a strict, independent goal-completion evaluator.',
      'Assess the assistant response only against the goal and acceptance criteria.',
      'Return exactly one JSON object: {"action":"continue"|"complete"|"paused"|"none","reason":"...","continuationPrompt":"..."}.',
      'Use complete only when every criterion has concrete evidence. Use continue when more work is needed and give a concise continuationPrompt. Use paused for ambiguity, missing evidence, unsafe action, or evaluator uncertainty.',
    ],
    userPrompt: JSON.stringify({
      objective: input.goal.objective,
      acceptanceCriteria: input.goal.acceptanceCriteria,
      assistantText: input.assistantText,
    }),
  })
  const text = extractTextContent(response.message.content)
  return (
    parseEvaluationText(text) ?? {
      action: 'paused',
      reason: 'Goal evaluator did not return a valid decision.',
    }
  )
}

export class GoalService {
  readonly storage: GoalStorage
  readonly clock: Clock
  readonly leaseDurationMs: number
  private readonly idFactory: () => string

  constructor(options: GoalServiceOptions = {}) {
    this.storage = new GoalStorage({ rootDir: options.rootDir })
    this.clock = options.clock ?? systemClock
    this.leaseDurationMs = normaliseLeaseDuration(options.leaseDurationMs)
    this.idFactory = options.idFactory ?? randomUUID
  }

  private now(value?: number): number {
    return typeof value === 'number' && Number.isFinite(value)
      ? value
      : this.clock.now()
  }

  private revise(goal: Goal, now: number, patch: Partial<Goal>): Goal {
    return {
      ...goal,
      ...patch,
      revision: goal.revision + 1,
      updatedAt: now,
    }
  }

  private emit(args: Parameters<typeof appendGoalEvent>[1]): void {
    appendGoalEvent(this.storage, args)
  }

  private transition(
    goalId: string,
    target: GoalStatus,
    options: {
      now?: number
      message?: string
      patch?: Partial<Goal>
      event?: Parameters<typeof appendGoalEvent>[1]['type']
      /** Fence an asynchronous mutation to the GoalRun that produced it. */
      runId?: string
    } = {},
  ): Goal | null {
    const now = this.now(options.now)
    const changed = this.storage.mutateGoal(goalId, current => {
      if (!transitionAllowed(current.status, target)) {
        throw new Error(
          `Goal ${current.id} cannot transition from ${current.status} to ${target}.`,
        )
      }
      if (
        options.runId &&
        (current.lease?.runId !== options.runId ||
          current.activeRun?.id !== options.runId)
      ) {
        return null
      }
      const next = this.revise(current, now, {
        ...(options.patch ?? {}),
        status: target,
      })
      return { goal: next, result: undefined }
    })
    if (!changed) return null
    this.emit({
      goal: changed.goal,
      type: options.event ?? (target === 'completed' ? 'completed' : 'paused'),
      at: now,
      from: changed.before.status,
      to: target,
      message: options.message,
    })
    return changed.goal
  }

  createGoal(input: CreateGoalInput): Goal {
    const now = this.now()
    const id = cleanText(input.id ?? this.idFactory(), 'Goal ID')
    const objective = cleanText(input.objective, 'Goal objective')
    const cwd = resolve(cleanText(input.cwd, 'Goal cwd'))
    const sessionId = cleanText(input.sessionId, 'Goal sessionId')
    const schedule = this.createSchedule({
      input: input.schedule,
      goalId: id,
      cwd,
      sessionId,
      now,
    })
    const loop = {
      maxIterations: Math.max(
        1,
        Math.floor(input.loop?.maxIterations ?? DEFAULT_MAX_ITERATIONS),
      ),
      continuationPrompt:
        input.loop?.continuationPrompt?.trim() || DEFAULT_CONTINUATION_PROMPT,
    }
    const goal: Goal = {
      schemaVersion: GOAL_SCHEMA_VERSION,
      id,
      cwd,
      sessionId,
      objective,
      acceptanceCriteria: cleanCriteria(input.acceptanceCriteria),
      status: 'scheduled',
      schedule,
      loop,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      ...(input.metadata ? { metadata: clone(input.metadata) } : {}),
    }
    const created = this.storage.createGoal(goal)
    this.emit({ goal: created, type: 'created', at: now, to: created.status })
    return created
  }

  /**
   * Creates a durable, not-yet-claimed Goal for the daemon HTTP control plane.
   * Returns null when a GoalRun is already active for this workspace/session.
   */
  createScheduledForControlPlane(
    input: CreateScheduledGoalControlPlaneInput,
  ): Goal | null {
    const cwd = resolve(cleanText(input.cwd, 'Goal cwd'))
    const sessionId = cleanText(input.sessionId, 'Goal sessionId')
    const objective = cleanText(input.objective, 'Goal objective')
    const acceptanceCriteria = cleanCriteria(input.acceptanceCriteria)
    const now = this.now()
    const schedule: ScheduleInput =
      input.schedule.kind === 'once'
        ? {
            kind: 'once',
            prompt: objective,
            ...(input.schedule.runAt !== undefined
              ? { runAt: input.schedule.runAt }
              : {}),
          }
        : {
            kind: 'interval',
            prompt: objective,
            everyMs: input.schedule.everyMs,
            // Match /loop: defer the first cadence unless the caller supplies
            // an explicit anchor. Immediate due would race the create response.
            anchorAt:
              input.schedule.anchorAt !== undefined
                ? input.schedule.anchorAt
                : now + Math.max(1, Math.floor(input.schedule.everyMs)),
          }

    return this.storage.withScopeLock({ cwd, sessionId }, () => {
      if (this.findActiveGoal({ cwd, sessionId })) return null
      return this.createGoal({
        cwd,
        sessionId,
        objective,
        acceptanceCriteria,
        schedule,
      })
    })
  }

  /**
   * Safely changes an inactive, session-bound Goal schedule from the daemon
   * control plane. Rejects goals with a lease or active run so HTTP writes
   * cannot orphan a live turn.
   */
  transitionScheduleForControlPlane(
    input: ControlPlaneGoalScheduleTransitionInput,
  ): ControlPlaneGoalScheduleTransitionResult {
    const cwd = resolve(cleanText(input.cwd, 'Goal cwd'))
    const sessionId = cleanText(input.sessionId, 'Goal sessionId')
    const scheduleId = cleanText(input.scheduleId, 'Schedule ID')
    if (
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 1 ||
      !['pause', 'resume', 'cancel'].includes(input.action)
    ) {
      return { ok: false, reason: 'invalid_request' }
    }

    const now = this.now(input.now)
    const message = input.reason?.trim()
    return this.storage.withScopeLock({ cwd, sessionId }, () => {
      const selected = this.storage
        .listGoals()
        .find(
          goal =>
            goal.cwd === cwd &&
            goal.sessionId === sessionId &&
            goal.schedule.id === scheduleId,
        )
      if (!selected) return { ok: false, reason: 'not_found' }

      let failure:
        | Exclude<
            ControlPlaneGoalScheduleTransitionResult,
            { ok: true }
          >['reason']
        | null = null
      const changed = this.storage.mutateGoal<{
        event: 'paused' | 'released' | 'cancelled'
        message?: string
      }>(selected.id, current => {
        if (
          current.cwd !== cwd ||
          current.sessionId !== sessionId ||
          current.schedule.id !== scheduleId
        ) {
          failure = 'not_found'
          return null
        }
        if (current.revision !== input.expectedRevision) {
          failure = 'revision_conflict'
          return null
        }
        if (
          current.lease ||
          current.activeRun ||
          current.status === 'running' ||
          current.status === 'awaiting_approval'
        ) {
          failure = 'active_run'
          return null
        }

        if (input.action === 'pause') {
          if (current.status !== 'scheduled') {
            failure = 'invalid_state'
            return null
          }
          const goal = this.revise(current, now, {
            status: 'paused',
            pausedReason: message || 'Paused by control plane.',
          })
          return { goal, result: { event: 'paused' as const, message } }
        }

        if (input.action === 'resume') {
          if (current.status !== 'paused') {
            failure = 'invalid_state'
            return null
          }
          const schedule: Schedule = { ...current.schedule }
          if (schedule.nextRunAt === null || schedule.nextRunAt <= now) {
            schedule.retryAt = now
          }
          const goal = this.revise(current, now, {
            status: 'scheduled',
            schedule,
            pausedReason: undefined,
          })
          return { goal, result: { event: 'released' as const, message } }
        }

        if (current.status !== 'scheduled' && current.status !== 'paused') {
          failure = 'invalid_state'
          return null
        }
        const goal = this.revise(current, now, {
          status: 'cancelled',
          pausedReason: message || 'Cancelled by control plane.',
        })
        return { goal, result: { event: 'cancelled' as const, message } }
      })
      if (!changed) return { ok: false, reason: failure ?? 'not_found' }

      this.emit({
        goal: changed.goal,
        type: changed.result.event,
        at: now,
        from: changed.before.status,
        to: changed.goal.status,
        message: changed.result.message,
      })
      return { ok: true, goal: changed.goal }
    })
  }

  /**
   * Creates and claims a one-off goal immediately. This is the session-scoped
   * `/goal` primitive: no scheduler tick is required before the engine can see
   * an active GoalRun for the current session.
   */
  startGoal(input: {
    cwd: string
    sessionId: string
    objective: string
    acceptanceCriteria?: string[]
    maxIterations?: number
    prompt?: string
    metadata?: Record<string, unknown>
    now?: number
    ownerId?: string
  }): Goal {
    const now = this.now(input.now)
    const cwd = resolve(cleanText(input.cwd, 'Goal cwd'))
    const sessionId = cleanText(input.sessionId, 'Goal sessionId')
    return this.storage.withScopeLock({ cwd, sessionId }, () => {
      const active = this.findActiveGoal({ cwd, sessionId })
      if (active) {
        throw new Error(
          `An active goal already exists for this session: ${active.id}. Cancel or complete it before starting another.`,
        )
      }

      const created = this.createGoal({
        cwd,
        sessionId,
        objective: input.objective,
        acceptanceCriteria: input.acceptanceCriteria,
        schedule: {
          kind: 'once',
          prompt: input.prompt?.trim() || input.objective,
          runAt: now,
        },
        loop: {
          ...(typeof input.maxIterations === 'number'
            ? { maxIterations: input.maxIterations }
            : {}),
        },
        metadata: input.metadata,
      })
      this.claimDueSchedulesUnlocked({
        cwd,
        sessionId,
        goalId: created.id,
        now,
        ownerId: input.ownerId ?? `goal:${sessionId}`,
      })
      return this.getGoal(created.id) ?? created
    })
  }

  private createSchedule(args: {
    input: ScheduleInput
    goalId: string
    cwd: string
    sessionId: string
    now: number
  }): Schedule {
    const prompt = cleanText(args.input.prompt, 'Schedule prompt')
    const base = {
      id: `schedule-${args.goalId}`,
      goalId: args.goalId,
      cwd: args.cwd,
      sessionId: args.sessionId,
      prompt,
    }
    if (args.input.kind === 'once') {
      const runAt = Number.isFinite(args.input.runAt)
        ? Math.floor(args.input.runAt!)
        : args.now
      return { ...base, kind: 'once', runAt, nextRunAt: runAt }
    }
    const everyMs = Math.floor(args.input.everyMs)
    if (!Number.isFinite(everyMs) || everyMs <= 0) {
      throw new Error('Interval schedule everyMs must be a positive number.')
    }
    const anchorAt = Number.isFinite(args.input.anchorAt)
      ? Math.floor(args.input.anchorAt!)
      : args.now
    return {
      ...base,
      kind: 'interval',
      everyMs,
      anchorAt,
      nextRunAt: anchorAt,
    }
  }

  getGoal(goalId: string): Goal | null {
    return this.storage.getGoal(goalId)
  }

  listGoals(): Goal[] {
    return this.storage.listGoals()
  }

  findActiveGoal(args: { cwd: string; sessionId: string }): Goal | null {
    const cwd = resolve(args.cwd)
    return (
      this.storage
        .listGoals()
        .filter(
          goal =>
            goal.cwd === cwd &&
            goal.sessionId === args.sessionId &&
            (goal.status === 'running' || goal.status === 'awaiting_approval'),
        )
        .sort(
          (a, b) => b.updatedAt - a.updatedAt || b.revision - a.revision,
        )[0] ?? null
    )
  }

  /**
   * Atomically claims at most one due schedule for one session. An interval
   * jumps directly to its first future slot, so outages never generate a burst
   * of catch-up prompts or concurrent active GoalRuns.
   */
  claimDueSchedules(input: ClaimDueSchedulesInput): ClaimedSchedule[] {
    const cwd = resolve(input.cwd)
    const sessionId = cleanText(input.sessionId, 'Goal sessionId')
    return this.storage.withScopeLock({ cwd, sessionId }, () =>
      this.claimDueSchedulesUnlocked({ ...input, cwd, sessionId }),
    )
  }

  private claimDueSchedulesUnlocked(
    input: ClaimDueSchedulesInput,
  ): ClaimedSchedule[] {
    const now = this.now(input.now)
    const cwd = resolve(input.cwd)
    const sessionId = cleanText(input.sessionId, 'Goal sessionId')
    const ownerId = input.ownerId?.trim() || `scheduler:${sessionId}`
    // The engine evaluates one final answer per session. Claiming another goal
    // while one is active would strand the older run behind findActiveGoal().
    if (this.findActiveGoal({ cwd, sessionId })) return []
    const limit = Number.isFinite(input.limit)
      ? Math.max(1, Math.min(1, Math.floor(input.limit!)))
      : 1
    const leaseDurationMs = normaliseLeaseDuration(
      input.leaseDurationMs ?? this.leaseDurationMs,
    )
    const candidates = this.storage
      .listGoals()
      .filter(
        goal =>
          goal.status === 'scheduled' &&
          goal.cwd === cwd &&
          goal.sessionId === sessionId &&
          (!input.goalId || goal.id === input.goalId) &&
          (() => {
            const at = dueAt(goal.schedule)
            return at !== null && at <= now
          })(),
      )
      .sort((a, b) => {
        const aDue = dueAt(a.schedule) ?? Number.MAX_SAFE_INTEGER
        const bDue = dueAt(b.schedule) ?? Number.MAX_SAFE_INTEGER
        return aDue - bDue || a.createdAt - b.createdAt
      })
      .slice(0, limit)

    const claimed: ClaimedSchedule[] = []
    for (const candidate of candidates) {
      const changed = this.storage.mutateGoal(candidate.id, current => {
        if (
          current.status !== 'scheduled' ||
          current.cwd !== cwd ||
          current.sessionId !== sessionId ||
          (input.goalId !== undefined && current.id !== input.goalId)
        ) {
          return null
        }
        const scheduledFor = dueAt(current.schedule)
        if (scheduledFor === null || scheduledFor > now) return null

        const fromRetry = current.schedule.retryAt !== undefined
        const schedule: Schedule = { ...current.schedule, retryAt: undefined }
        if (schedule.kind === 'once') {
          schedule.nextRunAt = null
        } else if (fromRetry) {
          const regular = schedule.nextRunAt ?? schedule.anchorAt
          schedule.nextRunAt =
            regular > now
              ? regular
              : nextFixedIntervalAt(regular, schedule.everyMs, now)
        } else {
          schedule.nextRunAt = nextFixedIntervalAt(
            scheduledFor,
            schedule.everyMs,
            now,
          )
        }
        schedule.lastClaimedAt = now

        const runId = this.idFactory()
        const lease: GoalLease = {
          ownerId,
          runId,
          acquiredAt: now,
          expiresAt: now + leaseDurationMs,
        }
        const next = this.revise(current, now, {
          status: 'running',
          schedule,
          lease,
          activeRun: {
            id: runId,
            scheduleId: schedule.id,
            scheduledFor,
            startedAt: now,
            turnCount: 0,
          },
          pausedReason: undefined,
          lastError: undefined,
        })
        return {
          goal: next,
          result: { ...clone(schedule), runId } satisfies ClaimedSchedule,
        }
      })
      if (!changed) continue
      this.emit({
        goal: changed.goal,
        type: 'claimed',
        at: now,
        from: changed.before.status,
        to: changed.goal.status,
        data: {
          runId: changed.goal.activeRun?.id ?? '',
          scheduledFor: changed.goal.activeRun?.scheduledFor ?? now,
        },
      })
      claimed.push(changed.result)
    }
    return claimed
  }

  renewLease(args: {
    goalId: string
    runId: string
    now?: number
  }): Goal | null {
    const now = this.now(args.now)
    const changed = this.storage.mutateGoal(args.goalId, current => {
      if (
        current.status !== 'running' ||
        current.lease?.runId !== args.runId ||
        current.activeRun?.id !== args.runId
      ) {
        return null
      }
      return {
        goal: this.revise(current, now, {
          lease: {
            ...current.lease,
            expiresAt: now + this.leaseDurationMs,
          },
        }),
        result: undefined,
      }
    })
    return changed?.goal ?? null
  }

  recoverInterruptedGoals(input: RecoverInterruptedGoalsInput = {}): Goal[] {
    const now = this.now(input.now)
    const cwd = input.cwd ? resolve(input.cwd) : undefined
    const sessionId = input.sessionId?.trim() || undefined
    const recovered: Goal[] = []
    for (const candidate of this.storage.listGoals()) {
      if (
        candidate.status !== 'running' ||
        !candidate.lease ||
        candidate.lease.expiresAt > now ||
        (cwd !== undefined && candidate.cwd !== cwd) ||
        (sessionId !== undefined && candidate.sessionId !== sessionId)
      ) {
        continue
      }
      const changed = this.storage.mutateGoal(candidate.id, current => {
        if (
          current.status !== 'running' ||
          !current.lease ||
          current.lease.expiresAt > now ||
          (cwd !== undefined && current.cwd !== cwd) ||
          (sessionId !== undefined && current.sessionId !== sessionId)
        ) {
          return null
        }
        const schedule: Schedule = { ...current.schedule, retryAt: now }
        const next = this.revise(current, now, {
          status: 'scheduled',
          schedule,
          lease: undefined,
          activeRun: undefined,
          lastError: {
            code: 'lease_expired',
            message: 'The prior GoalRun lease expired before completion.',
            at: now,
          },
        })
        return { goal: next, result: undefined }
      })
      if (!changed) continue
      this.emit({
        goal: changed.goal,
        type: 'recovered',
        at: now,
        from: changed.before.status,
        to: changed.goal.status,
        message: changed.goal.lastError?.message,
      })
      recovered.push(changed.goal)
    }
    return recovered
  }

  completeGoal(
    goalId: string,
    options: { now?: number; reason?: string; runId: string },
  ): Goal | null {
    const now = this.now(options.now)
    return this.transition(goalId, 'completed', {
      now,
      event: 'completed',
      message: options.reason,
      runId: options.runId,
      patch: {
        completedAt: now,
        lease: undefined,
        activeRun: undefined,
        pausedReason: undefined,
      },
    })
  }

  pauseGoal(
    goalId: string,
    options: { now?: number; reason?: string; runId?: string } = {},
  ): Goal | null {
    return this.transition(goalId, 'paused', {
      now: options.now,
      event: 'paused',
      message: options.reason,
      runId: options.runId,
      patch: {
        lease: undefined,
        activeRun: undefined,
        pausedReason: options.reason?.trim() || 'Paused by goal policy.',
      },
    })
  }

  failGoal(
    goalId: string,
    options: { now?: number; reason: string; runId?: string },
  ): Goal | null {
    const now = this.now(options.now)
    return this.transition(goalId, 'failed', {
      now,
      event: 'failed',
      message: options.reason,
      runId: options.runId,
      patch: {
        lease: undefined,
        activeRun: undefined,
        lastError: {
          code: 'goal_failed',
          message: cleanText(options.reason, 'Failure reason'),
          at: now,
        },
      },
    })
  }

  cancelGoal(
    goalId: string,
    options: { now?: number; reason?: string } = {},
  ): Goal | null {
    return this.transition(goalId, 'cancelled', {
      now: options.now,
      event: 'cancelled',
      message: options.reason,
      patch: {
        lease: undefined,
        activeRun: undefined,
        pausedReason: options.reason?.trim() || 'Cancelled by user.',
      },
    })
  }

  requestApproval(
    goalId: string,
    options: { now?: number; reason: string; runId?: string },
  ): Goal | null {
    return this.transition(goalId, 'awaiting_approval', {
      now: options.now,
      event: 'approval_requested',
      message: options.reason,
      runId: options.runId,
      patch: {
        lease: undefined,
        pausedReason: cleanText(options.reason, 'Approval reason'),
      },
    })
  }

  resumeGoal(
    goalId: string,
    options: { now?: number; reason?: string } = {},
  ): Goal | null {
    const now = this.now(options.now)
    const changed = this.storage.mutateGoal(goalId, current => {
      if (!transitionAllowed(current.status, 'scheduled')) {
        throw new Error(
          `Goal ${current.id} cannot transition from ${current.status} to scheduled.`,
        )
      }
      const schedule: Schedule = { ...current.schedule }
      if (schedule.nextRunAt === null) schedule.retryAt = now
      else if (
        schedule.nextRunAt > now &&
        current.status !== 'awaiting_approval'
      ) {
        // Retain an existing future cadence; explicit resumes do not duplicate it.
      } else {
        schedule.retryAt = now
      }
      const next = this.revise(current, now, {
        status: 'scheduled',
        schedule,
        lease: undefined,
        activeRun: undefined,
        pausedReason: undefined,
      })
      return { goal: next, result: undefined }
    })
    if (!changed) return null
    this.emit({
      goal: changed.goal,
      type: 'released',
      at: now,
      from: changed.before.status,
      to: changed.goal.status,
      message: options.reason,
    })
    return changed.goal
  }

  recordContinuation(
    goalId: string,
    options: { now?: number; reason?: string; runId: string },
  ): Goal | null {
    const now = this.now(options.now)
    const changed = this.storage.mutateGoal(goalId, current => {
      if (
        current.status !== 'running' ||
        !current.activeRun ||
        current.lease?.runId !== options.runId ||
        current.activeRun.id !== options.runId
      ) {
        return null
      }
      const turnCount = current.activeRun.turnCount + 1
      if (turnCount > current.loop.maxIterations) {
        const next = this.revise(current, now, {
          status: 'paused',
          lease: undefined,
          activeRun: undefined,
          pausedReason: `Goal loop limit reached (${current.loop.maxIterations}).`,
        })
        return { goal: next, result: 'limit' as const }
      }
      const next = this.revise(current, now, {
        activeRun: { ...current.activeRun, turnCount },
        lease: current.lease
          ? { ...current.lease, expiresAt: now + this.leaseDurationMs }
          : undefined,
      })
      return { goal: next, result: 'continued' as const }
    })
    if (!changed) return null
    this.emit({
      goal: changed.goal,
      type: changed.result === 'limit' ? 'paused' : 'continued',
      at: now,
      from: changed.before.status,
      to: changed.goal.status,
      message:
        changed.result === 'limit' ? changed.goal.pausedReason : options.reason,
    })
    return changed.goal
  }

  /**
   * A final answer with no evaluator action releases interval goals back to
   * their future fixed slot. A consumed one-off pauses instead of silently
   * claiming success.
   */
  releaseAfterTurn(
    goalId: string,
    options: { now?: number; reason?: string; runId: string },
  ): Goal | null {
    const goal = this.getGoal(goalId)
    if (!goal || goal.status !== 'running') return null
    if (goal.schedule.kind === 'once') {
      return this.pauseGoal(goalId, {
        now: options.now,
        runId: options.runId,
        reason:
          options.reason ??
          'One-off goal finished without a completion decision; review before resuming.',
      })
    }
    return this.transition(goalId, 'scheduled', {
      now: options.now,
      event: 'released',
      message: options.reason,
      runId: options.runId,
      patch: { lease: undefined, activeRun: undefined },
    })
  }
}

export async function evaluateActiveGoalAfterTurn(args: {
  cwd: string
  sessionId: string
  assistantText: string
  signal?: AbortSignal
  evaluate?: GoalTurnEvaluator
  now?: number
  rootDir?: string
  leaseDurationMs?: number
}): Promise<GoalTurnEvaluationResult> {
  const clock: Clock = {
    now: () => (typeof args.now === 'number' ? args.now : Date.now()),
  }
  const service = new GoalService({
    rootDir: args.rootDir,
    clock,
    leaseDurationMs: args.leaseDurationMs,
  })
  const now = clock.now()
  const goal = service.findActiveGoal({
    cwd: args.cwd,
    sessionId: args.sessionId,
  })
  if (!goal) return { action: 'none' }
  if (goal.status === 'awaiting_approval') {
    return { action: 'paused', goal, reason: goal.pausedReason }
  }
  const runId = goal.activeRun?.id
  const staleResult = (): GoalTurnEvaluationResult => ({
    action: 'none',
    goal: service.getGoal(goal.id) ?? goal,
    reason: 'GoalRun changed before the evaluator decision was applied.',
  })
  if (!runId || goal.lease?.runId !== runId) {
    return {
      action: 'paused',
      goal,
      reason: 'Active GoalRun is missing a valid lease identity.',
    }
  }
  if (goal.lease && goal.lease.expiresAt <= now) {
    const recovered = service
      .recoverInterruptedGoals({
        now,
        cwd: args.cwd,
        sessionId: args.sessionId,
      })
      .find(candidate => candidate.id === goal.id)
    return {
      action: 'expired',
      ...(recovered ? { goal: recovered } : { goal }),
      reason: 'GoalRun lease expired before the final answer was evaluated.',
    }
  }
  if (args.signal?.aborted) {
    const paused = service.pauseGoal(goal.id, {
      now,
      runId,
      reason: 'Goal evaluation was aborted.',
    })
    if (!paused) return staleResult()
    return {
      action: 'paused',
      goal: paused ?? goal,
      reason: paused?.pausedReason,
    }
  }

  // An interval loop is a scheduled routine, not a one-shot acceptance loop.
  // Its completed turn returns to the next fixed cadence (with no catch-up),
  // so a quick evaluator cannot accidentally terminate a recurring watch.
  if (goal.schedule.kind === 'interval') {
    const released = service.releaseAfterTurn(goal.id, {
      now,
      runId,
      reason: 'Scheduled loop turn completed.',
    })
    if (!released) return staleResult()
    return {
      action: 'none',
      goal: released ?? goal,
      reason: 'Scheduled loop returned to its next cadence.',
    }
  }

  let decision: GoalTurnEvaluation
  try {
    decision = await (args.evaluate ?? defaultGoalTurnEvaluator)({
      goal,
      cwd: args.cwd,
      sessionId: args.sessionId,
      assistantText: args.assistantText,
      signal: args.signal,
    })
  } catch (error) {
    const reason =
      error instanceof Error
        ? error.message
        : 'Goal evaluator failed unexpectedly.'
    const paused = service.pauseGoal(goal.id, { now, reason, runId })
    if (!paused) return staleResult()
    return { action: 'paused', goal: paused ?? goal, reason }
  }

  switch (decision.action) {
    case 'continue': {
      const continued = service.recordContinuation(goal.id, {
        now,
        runId,
        reason: decision.reason,
      })
      if (!continued) return staleResult()
      if (continued.status !== 'running') {
        return {
          action: 'paused',
          goal: continued ?? goal,
          reason: continued?.pausedReason ?? 'Goal could not continue.',
        }
      }
      return {
        action: 'continue',
        goal: continued,
        continuationPrompt:
          decision.continuationPrompt?.trim() ||
          continued.loop.continuationPrompt,
        ...(decision.reason ? { reason: decision.reason } : {}),
      }
    }
    case 'complete': {
      const completed = service.completeGoal(goal.id, {
        now,
        runId,
        reason: decision.reason,
      })
      if (!completed) return staleResult()
      return {
        action: 'complete',
        goal: completed ?? goal,
        ...(decision.reason ? { reason: decision.reason } : {}),
      }
    }
    case 'paused': {
      const paused = service.pauseGoal(goal.id, {
        now,
        runId,
        reason: decision.reason ?? 'Goal evaluator requested a pause.',
      })
      if (!paused) return staleResult()
      return {
        action: 'paused',
        goal: paused ?? goal,
        reason: paused?.pausedReason ?? decision.reason,
      }
    }
    case 'none': {
      const released = service.releaseAfterTurn(goal.id, {
        now,
        runId,
        reason: decision.reason,
      })
      if (!released) return staleResult()
      return {
        action: 'none',
        goal: released ?? goal,
        ...(decision.reason ? { reason: decision.reason } : {}),
      }
    }
  }
}

/** Session-scoped convenience API used by `/goal`. */
export function startGoal(args: {
  cwd: string
  sessionId: string
  objective: string
  acceptanceCriteria?: string[]
  maxIterations?: number
  prompt?: string
  metadata?: Record<string, unknown>
  now?: number
  rootDir?: string
  leaseDurationMs?: number
  ownerId?: string
}): Goal {
  const clock: Clock = {
    now: () => (typeof args.now === 'number' ? args.now : Date.now()),
  }
  return new GoalService({
    rootDir: args.rootDir,
    clock,
    leaseDurationMs: args.leaseDurationMs,
  }).startGoal(args)
}
