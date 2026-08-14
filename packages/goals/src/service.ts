import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import { appendGoalEvent } from './events'
import { GoalStorage } from './storage'
import {
  GOAL_SCHEMA_VERSION,
  MAX_GOAL_CONTINUATION_PROMPT_CHARS,
  MAX_GOAL_CONTINUATIONS,
  MAX_GOAL_ID_CHARS,
  MAX_GOAL_OBJECTIVE_CHARS,
  MAX_GOAL_PROMPT_CHARS,
  MAX_GOAL_REASON_CHARS,
  systemClock,
  type ClaimDueSchedulesInput,
  type ClaimedSchedule,
  type Clock,
  type ControlPlaneGoalScheduleTransitionInput,
  type ControlPlaneGoalScheduleTransitionResult,
  type ControlPlaneGoalScheduleUpdateInput,
  type ControlPlaneGoalScheduleUpdateResult,
  type CreateGoalInput,
  type CreateScheduledGoalControlPlaneInput,
  type Goal,
  type GoalEvent,
  type GoalLease,
  type GoalServiceOptions,
  type GoalSchedulePollResult,
  type GoalStatus,
  type GoalTurnEvaluation,
  type GoalTurnEvaluationResult,
  type GoalTurnEvaluator,
  type GoalVerificationEvidence,
  type RecoverInterruptedGoalsInput,
  type Schedule,
  type ScheduleInput,
} from './types'
import { isBackgroundKeepAliveGoal } from './backgroundKeepAlive'
import {
  createScheduledForControlPlaneImpl,
  listScheduleEventsForControlPlaneImpl,
  transitionScheduleForControlPlaneImpl,
  updateScheduleForControlPlaneImpl,
} from './controlPlane'
import {
  DEFAULT_MAX_ITERATIONS,
  cleanCriteria,
  cleanOptionalReason,
  cleanText,
  nextDeferredIntervalAt,
  normaliseMaxIterations,
} from './internalUtil'

const DEFAULT_LEASE_DURATION_MS = 10 * 60 * 1000
const MAX_LEASE_DURATION_MS = 24 * 60 * 60 * 1000
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
  completed: new Set(),
  failed: new Set(['scheduled', 'paused', 'cancelled']),
  cancelled: new Set(),
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function normaliseLeaseDuration(value: number | undefined): number {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) {
    return DEFAULT_LEASE_DURATION_MS
  }
  return Math.min(MAX_LEASE_DURATION_MS, Math.max(1_000, Math.floor(value!)))
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
): number | null {
  const firstNext = scheduledAt + everyMs
  if (firstNext > now) {
    return Number.isSafeInteger(firstNext) ? firstNext : null
  }
  const skipped = Math.floor((now - scheduledAt) / everyMs) + 1
  const next = scheduledAt + skipped * everyMs
  return Number.isSafeInteger(next) ? next : null
}

function futureTimestamp(now: number, delayMs: number, name: string): number {
  const value = now + delayMs
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} exceeds the supported timestamp range.`)
  }
  return value
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

function normaliseEvaluationDecision(value: unknown): GoalTurnEvaluation {
  if (!value || typeof value !== 'object') {
    return {
      action: 'paused',
      reason: 'Goal evaluator returned an invalid decision.',
    }
  }
  const record = value as Record<string, unknown>
  if (
    !['continue', 'complete', 'paused', 'none'].includes(String(record.action))
  ) {
    return {
      action: 'paused',
      reason: 'Goal evaluator returned an invalid decision.',
    }
  }
  const reason =
    typeof record.reason === 'string' && record.reason.trim()
      ? record.reason.trim().slice(0, MAX_GOAL_REASON_CHARS)
      : undefined
  const continuationPrompt =
    typeof record.continuationPrompt === 'string' &&
    record.continuationPrompt.trim()
      ? record.continuationPrompt
          .trim()
          .slice(0, MAX_GOAL_CONTINUATION_PROMPT_CHARS)
      : undefined
  return {
    action: record.action as GoalTurnEvaluation['action'],
    ...(reason ? { reason } : {}),
    ...(continuationPrompt ? { continuationPrompt } : {}),
  }
}

function requiredVerificationKinds(
  goal: Goal,
): GoalVerificationEvidence['kind'][] {
  const requirements = [goal.objective, ...goal.acceptanceCriteria].join('\n')
  const required = new Set<GoalVerificationEvidence['kind']>()
  if (
    /\b(?:test(?:s|ed|ing)?|jest|vitest|pytest|mocha|ava)\b|测试/i.test(
      requirements,
    )
  ) {
    required.add('test')
  }
  if (
    /\b(?:type\s*check|typecheck|tsc|pyright|mypy)\b|类型检查/i.test(
      requirements,
    )
  ) {
    required.add('typecheck')
  }
  if (
    /\b(?:lint|eslint|oxlint|biome|ruff)\b|静态检查|代码检查/i.test(
      requirements,
    )
  ) {
    required.add('lint')
  }
  if (/\b(?:build|compile|tsup|vite build)\b|构建|编译/i.test(requirements)) {
    required.add('build')
  }
  return Array.from(required)
}

function enforceRequiredVerificationEvidence(
  goal: Goal,
  evidence: GoalVerificationEvidence[],
  decision: GoalTurnEvaluation,
): GoalTurnEvaluation {
  if (decision.action !== 'complete') return decision

  const passedKinds = new Set(
    evidence
      .filter(
        receipt =>
          receipt.status === 'passed' &&
          Date.parse(receipt.recordedAt) >= goal.createdAt,
      )
      .map(receipt => receipt.kind),
  )
  const missingKinds = requiredVerificationKinds(goal).filter(
    kind => !passedKinds.has(kind),
  )
  if (missingKinds.length === 0) return decision

  const labels = missingKinds.join(', ')
  return {
    action: 'continue',
    reason: `Completion requires fresh passed verification evidence for: ${labels}.`,
    continuationPrompt: `Run the required ${labels} verification after the latest source change and collect its result before completing the goal.`,
  }
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
      'Verification evidence is engine-generated and only proves the exact recorded command after the latest detected write. Never invent a passing execution result from assistant text. A failed, blocked, interrupted, or started receipt is not passing evidence. Do not require a receipt when an acceptance criterion does not need command execution.',
    ],
    userPrompt: JSON.stringify({
      objective: input.goal.objective,
      acceptanceCriteria: input.goal.acceptanceCriteria,
      assistantText: input.assistantText,
      verificationEvidence: input.verificationEvidence ?? [],
    }),
  })
  const text = extractTextContent(response.message.content)
  const decision = normaliseEvaluationDecision(
    parseEvaluationText(text) ?? {
      action: 'paused',
      reason: 'Goal evaluator did not return a valid decision.',
    },
  )
  return enforceRequiredVerificationEvidence(
    input.goal,
    input.verificationEvidence ?? [],
    decision,
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

  /** @internal Shared with the control-plane module via GoalControlPlaneHost. */
  now(value?: number): number {
    const selected = value ?? this.clock.now()
    if (!Number.isSafeInteger(selected) || selected < 0) {
      throw new Error('Goal timestamp must be a non-negative safe integer.')
    }
    return selected
  }

  /** @internal Shared with the control-plane module via GoalControlPlaneHost. */
  revise(goal: Goal, now: number, patch: Partial<Goal>): Goal {
    return {
      ...goal,
      ...patch,
      revision: goal.revision + 1,
      updatedAt: now,
    }
  }

  /** @internal Shared with the control-plane module via GoalControlPlaneHost. */
  emit(args: Parameters<typeof appendGoalEvent>[1]): void {
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
    const message = cleanOptionalReason(options.message)
    const now = this.now(options.now)
    const changed = this.storage.mutateGoal(goalId, current => {
      if (
        options.runId &&
        (current.lease?.runId !== options.runId ||
          current.activeRun?.id !== options.runId)
      ) {
        // The GoalRun that produced this call no longer owns the goal: it
        // was recovered, completed, cancelled, or re-claimed. A fenced
        // mutation from a stale run must be a no-op — checked before the
        // transition table, because the goal may have left `running`
        // entirely (e.g. recovered back to `scheduled` after lease expiry)
        // where the target transition is no longer legal.
        return null
      }
      if (!transitionAllowed(current.status, target)) {
        throw new Error(
          `Goal ${current.id} cannot transition from ${current.status} to ${target}.`,
        )
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
      message,
    })
    return changed.goal
  }

  createGoal(input: CreateGoalInput): Goal {
    const now = this.now()
    const id = cleanText(
      input.id ?? this.idFactory(),
      'Goal ID',
      MAX_GOAL_ID_CHARS,
    )
    const objective = cleanText(
      input.objective,
      'Goal objective',
      MAX_GOAL_OBJECTIVE_CHARS,
    )
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
      maxIterations: normaliseMaxIterations(input.loop?.maxIterations),
      continuationPrompt: input.loop?.continuationPrompt
        ? cleanText(
            input.loop.continuationPrompt,
            'Goal continuationPrompt',
            MAX_GOAL_CONTINUATION_PROMPT_CHARS,
          )
        : DEFAULT_CONTINUATION_PROMPT,
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
    return createScheduledForControlPlaneImpl(this, input)
  }

  /**
   * Safely changes an inactive, session-bound Goal schedule from the daemon
   * control plane. Rejects goals with a lease or active run so HTTP writes
   * cannot orphan a live turn.
   */
  transitionScheduleForControlPlane(
    input: ControlPlaneGoalScheduleTransitionInput,
  ): ControlPlaneGoalScheduleTransitionResult {
    return transitionScheduleForControlPlaneImpl(this, input)
  }

  /**
   * Updates an idle goal definition with optimistic concurrency. A live lease
   * or GoalRun always wins: callers must pause the run before editing it.
   */
  updateScheduleForControlPlane(
    input: ControlPlaneGoalScheduleUpdateInput,
  ): ControlPlaneGoalScheduleUpdateResult {
    return updateScheduleForControlPlaneImpl(this, input)
  }

  /** Returns a bounded, session-scoped event journal for one schedule. */
  listScheduleEventsForControlPlane(input: {
    cwd: string
    sessionId: string
    scheduleId: string
    limit: number
  }): GoalEvent[] | null {
    return listScheduleEventsForControlPlaneImpl(this, input)
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

  /** @internal Shared with the control-plane module via GoalControlPlaneHost. */
  createSchedule(args: {
    input: ScheduleInput
    goalId: string
    cwd: string
    sessionId: string
    now: number
  }): Schedule {
    const prompt = cleanText(
      args.input.prompt,
      'Schedule prompt',
      MAX_GOAL_PROMPT_CHARS,
    )
    const base = {
      id: `schedule-${args.goalId}`,
      goalId: args.goalId,
      cwd: args.cwd,
      sessionId: args.sessionId,
      prompt,
    }
    if (args.input.kind === 'once') {
      if (
        args.input.runAt !== undefined &&
        (!Number.isSafeInteger(args.input.runAt) || args.input.runAt < 0)
      ) {
        throw new Error('Once schedule runAt must be a safe integer.')
      }
      const runAt = args.input.runAt ?? args.now
      return { ...base, kind: 'once', runAt, nextRunAt: runAt }
    }
    const everyMs = args.input.everyMs
    if (!Number.isSafeInteger(everyMs) || everyMs <= 0) {
      throw new Error(
        'Interval schedule everyMs must be a positive safe integer.',
      )
    }
    if (
      args.input.anchorAt !== undefined &&
      (!Number.isSafeInteger(args.input.anchorAt) || args.input.anchorAt < 0)
    ) {
      throw new Error('Interval schedule anchorAt must be a safe integer.')
    }
    const anchorAt = args.input.anchorAt ?? args.now
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

  /**
   * Event history for a goal. CLI/UI callers should use this instead of
   * reaching into the storage layer directly.
   */
  listGoalEvents(
    goalId: string,
    options: { limit?: number } = {},
  ): GoalEvent[] {
    return this.storage.listEvents(goalId, { limit: options.limit })
  }

  private findActiveGoalFrom(
    goals: Goal[],
    args: { cwd: string; sessionId: string },
  ): Goal | null {
    const cwd = resolve(args.cwd)
    return (
      goals
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

  findActiveGoal(args: { cwd: string; sessionId: string }): Goal | null {
    return this.findActiveGoalFrom(this.storage.listGoals(), args)
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
    goals: Goal[] = this.storage.listGoals(),
  ): ClaimedSchedule[] {
    const now = this.now(input.now)
    const cwd = resolve(input.cwd)
    const sessionId = cleanText(input.sessionId, 'Goal sessionId')
    const ownerId = input.ownerId?.trim() || `scheduler:${sessionId}`
    // The engine evaluates one final answer per session. Claiming another goal
    // while one is active would strand the older run behind findActiveGoal().
    if (this.findActiveGoalFrom(goals, { cwd, sessionId })) return []
    // A single host tick claims at most one schedule — always the earliest
    // due — because the engine can process only one goal run per session.
    const leaseDurationMs = normaliseLeaseDuration(
      input.leaseDurationMs ?? this.leaseDurationMs,
    )
    const candidate = goals
      .filter(
        goal =>
          goal.status === 'scheduled' &&
          goal.cwd === cwd &&
          goal.sessionId === sessionId &&
          (!input.backgroundOnly || isBackgroundKeepAliveGoal(goal)) &&
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
      })[0]
    if (!candidate) return []

    const changed = this.storage.mutateGoal(candidate.id, current => {
      if (
        current.status !== 'scheduled' ||
        current.cwd !== cwd ||
        current.sessionId !== sessionId ||
        (input.backgroundOnly && !isBackgroundKeepAliveGoal(current)) ||
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
        expiresAt: futureTimestamp(now, leaseDurationMs, 'Goal lease'),
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
    if (!changed) return []
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
    return [changed.result]
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
            expiresAt: futureTimestamp(now, this.leaseDurationMs, 'Goal lease'),
          },
        }),
        result: undefined,
      }
    })
    return changed?.goal ?? null
  }

  recoverInterruptedGoals(input: RecoverInterruptedGoalsInput = {}): Goal[] {
    return this.recoverInterruptedGoalsFrom(input, this.storage.listGoals())
  }

  private recoverInterruptedGoalsFrom(
    input: RecoverInterruptedGoalsInput,
    goals: Goal[],
  ): Goal[] {
    const now = this.now(input.now)
    const cwd = input.cwd ? resolve(input.cwd) : undefined
    const sessionId = input.sessionId?.trim() || undefined
    const recovered: Goal[] = []
    for (const candidate of goals) {
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

  /**
   * Poll one session from a single durable snapshot. Recovery, claiming, and
   * direct-run discovery share the workspace/session lock, avoiding repeated
   * full-directory scans on the one-second scheduler hot path.
   */
  pollDueSchedule(
    input: ClaimDueSchedulesInput,
  ): GoalSchedulePollResult | null {
    const cwd = resolve(input.cwd)
    const sessionId = cleanText(input.sessionId, 'Goal sessionId')
    const now = this.now(input.now)
    return this.storage.withScopeLock({ cwd, sessionId }, () => {
      const initial = this.storage.listGoals()
      const recovered = this.recoverInterruptedGoalsFrom(
        { now, cwd, sessionId },
        initial,
      )
      const recoveredById = new Map(recovered.map(goal => [goal.id, goal]))
      const snapshot = initial.map(goal => recoveredById.get(goal.id) ?? goal)
      const claimed = this.claimDueSchedulesUnlocked(
        { ...input, cwd, sessionId, now },
        snapshot,
      )[0]
      if (claimed) return { schedule: claimed, source: 'claimed' }

      const activeSnapshot = this.findActiveGoalFrom(snapshot, {
        cwd,
        sessionId,
      })
      const active = activeSnapshot
        ? this.storage.getGoal(activeSnapshot.id)
        : null
      if (
        !active ||
        active.status !== 'running' ||
        active.schedule.kind !== 'once' ||
        // A detached host must never pick up a run it is not allowed to
        // claim: the same backgroundOnly opt-in applies to re-surfacing an
        // already-claimed direct run.
        (input.backgroundOnly && !isBackgroundKeepAliveGoal(active)) ||
        active.activeRun?.turnCount !== 0 ||
        active.lease?.runId !== active.activeRun.id
      ) {
        return null
      }
      return {
        schedule: { ...active.schedule, runId: active.activeRun.id },
        source: 'unstarted',
      }
    })
  }

  completeGoal(
    goalId: string,
    options: { now?: number; reason?: string; runId: string },
  ): Goal | null {
    const now = this.now(options.now)
    const reason = cleanOptionalReason(options.reason)
    return this.transition(goalId, 'completed', {
      now,
      event: 'completed',
      message: reason,
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
    const reason =
      cleanOptionalReason(options.reason) ?? 'Paused by goal policy.'
    return this.transition(goalId, 'paused', {
      now: options.now,
      event: 'paused',
      message: reason,
      runId: options.runId,
      patch: {
        lease: undefined,
        activeRun: undefined,
        pausedReason: reason,
      },
    })
  }

  failGoal(
    goalId: string,
    options: { now?: number; reason: string; runId?: string },
  ): Goal | null {
    const now = this.now(options.now)
    const reason = cleanText(
      options.reason,
      'Failure reason',
      MAX_GOAL_REASON_CHARS,
    )
    return this.transition(goalId, 'failed', {
      now,
      event: 'failed',
      message: reason,
      runId: options.runId,
      patch: {
        lease: undefined,
        activeRun: undefined,
        lastError: {
          code: 'goal_failed',
          message: reason,
          at: now,
        },
      },
    })
  }

  cancelGoal(
    goalId: string,
    options: { now?: number; reason?: string } = {},
  ): Goal | null {
    const reason = cleanOptionalReason(options.reason) ?? 'Cancelled by user.'
    return this.transition(goalId, 'cancelled', {
      now: options.now,
      event: 'cancelled',
      message: reason,
      patch: {
        lease: undefined,
        activeRun: undefined,
        pausedReason: reason,
      },
    })
  }

  requestApproval(
    goalId: string,
    options: { now?: number; reason: string; runId?: string },
  ): Goal | null {
    const reason = cleanText(
      options.reason,
      'Approval reason',
      MAX_GOAL_REASON_CHARS,
    )
    return this.transition(goalId, 'awaiting_approval', {
      now: options.now,
      event: 'approval_requested',
      message: reason,
      runId: options.runId,
      patch: {
        lease: undefined,
        pausedReason: reason,
      },
    })
  }

  resumeGoal(
    goalId: string,
    options: { now?: number; reason?: string } = {},
  ): Goal | null {
    const now = this.now(options.now)
    const reason = cleanOptionalReason(options.reason)
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
      message: reason,
    })
    return changed.goal
  }

  recordContinuation(
    goalId: string,
    options: { now?: number; reason?: string; runId: string },
  ): Goal | null {
    const now = this.now(options.now)
    const reason = cleanOptionalReason(options.reason)
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
          ? {
              ...current.lease,
              expiresAt: futureTimestamp(
                now,
                this.leaseDurationMs,
                'Goal lease',
              ),
            }
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
      message: changed.result === 'limit' ? changed.goal.pausedReason : reason,
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
    const reason = cleanOptionalReason(options.reason)
    const goal = this.getGoal(goalId)
    if (!goal || goal.status !== 'running') return null
    if (goal.schedule.kind === 'once') {
      return this.pauseGoal(goalId, {
        now: options.now,
        runId: options.runId,
        reason:
          reason ??
          'One-off goal finished without a completion decision; review before resuming.',
      })
    }
    return this.transition(goalId, 'scheduled', {
      now: options.now,
      event: 'released',
      message: reason,
      runId: options.runId,
      patch: { lease: undefined, activeRun: undefined },
    })
  }
}

export async function evaluateActiveGoalAfterTurn(args: {
  cwd: string
  sessionId: string
  assistantText: string
  verificationEvidence?: GoalVerificationEvidence[]
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
    decision = normaliseEvaluationDecision(
      await (args.evaluate ?? defaultGoalTurnEvaluator)({
        goal,
        cwd: args.cwd,
        sessionId: args.sessionId,
        assistantText: args.assistantText,
        verificationEvidence: args.verificationEvidence,
        signal: args.signal,
      }),
    )
  } catch (error) {
    const reason =
      error instanceof Error
        ? error.message.slice(0, MAX_GOAL_REASON_CHARS)
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
