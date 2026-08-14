import { resolve } from 'node:path'

import { appendGoalEvent } from './events'
import { GoalStorage } from './storage'
import {
  MAX_GOAL_OBJECTIVE_CHARS,
  type ControlPlaneGoalScheduleTransitionInput,
  type ControlPlaneGoalScheduleTransitionResult,
  type ControlPlaneGoalScheduleUpdateInput,
  type ControlPlaneGoalScheduleUpdateResult,
  type CreateGoalInput,
  type CreateScheduledGoalControlPlaneInput,
  type Goal,
  type GoalEvent,
  type Schedule,
  type ScheduleInput,
} from './types'
import {
  cleanCriteria,
  cleanOptionalReason,
  cleanText,
  nextDeferredIntervalAt,
  normaliseMaxIterations,
} from './internalUtil'

/**
 * Narrow internal surface GoalService exposes to the daemon control-plane
 * implementations below. Keeps the HTTP-facing schedule mutations in one
 * module while GoalService owns the runtime state machine.
 */
export type GoalControlPlaneHost = {
  readonly storage: GoalStorage
  now(value?: number): number
  revise(goal: Goal, now: number, patch: Partial<Goal>): Goal
  emit(args: Parameters<typeof appendGoalEvent>[1]): void
  findActiveGoal(args: { cwd: string; sessionId: string }): Goal | null
  createSchedule(args: {
    input: ScheduleInput
    goalId: string
    cwd: string
    sessionId: string
    now: number
  }): Schedule
  createGoal(input: CreateGoalInput): Goal
}

export function createScheduledForControlPlaneImpl(
  host: GoalControlPlaneHost,
  input: CreateScheduledGoalControlPlaneInput,
): Goal | null {
  const cwd = resolve(cleanText(input.cwd, 'Goal cwd'))
  const sessionId = cleanText(input.sessionId, 'Goal sessionId')
  const objective = cleanText(
    input.objective,
    'Goal objective',
    MAX_GOAL_OBJECTIVE_CHARS,
  )
  const acceptanceCriteria = cleanCriteria(input.acceptanceCriteria)
  const now = host.now()
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
              : nextDeferredIntervalAt(now, input.schedule.everyMs),
        }

  return host.storage.withScopeLock({ cwd, sessionId }, () => {
    if (host.findActiveGoal({ cwd, sessionId })) return null
    return host.createGoal({
      cwd,
      sessionId,
      objective,
      acceptanceCriteria,
      schedule,
      loop:
        input.maxIterations !== undefined
          ? { maxIterations: input.maxIterations }
          : undefined,
    })
  })
}

/**
 * Safely changes an inactive, session-bound Goal schedule from the daemon
 * control plane. Rejects goals with a lease or active run so HTTP writes
 * cannot orphan a live turn.
 */
export function transitionScheduleForControlPlaneImpl(
  host: GoalControlPlaneHost,
  input: ControlPlaneGoalScheduleTransitionInput,
): ControlPlaneGoalScheduleTransitionResult {
  const cwd = resolve(cleanText(input.cwd, 'Goal cwd'))
  const sessionId = cleanText(input.sessionId, 'Goal sessionId')
  const scheduleId = cleanText(input.scheduleId, 'Schedule ID')
  if (
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1 ||
    !['pause', 'resume', 'retry', 'run_now', 'cancel'].includes(input.action)
  ) {
    return { ok: false, reason: 'invalid_request' }
  }

  const now = host.now(input.now)
  let message: string | undefined
  try {
    message = cleanOptionalReason(input.reason)
  } catch {
    return { ok: false, reason: 'invalid_request' }
  }
  return host.storage.withScopeLock({ cwd, sessionId }, () => {
    const selected = host.storage
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
    const changed = host.storage.mutateGoal<{
      event: 'paused' | 'resumed' | 'retried' | 'run_requested' | 'cancelled'
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
        const goal = host.revise(current, now, {
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
        const goal = host.revise(current, now, {
          status: 'scheduled',
          schedule,
          pausedReason: undefined,
        })
        return { goal, result: { event: 'resumed' as const, message } }
      }

      if (input.action === 'retry') {
        if (current.status !== 'failed') {
          failure = 'invalid_state'
          return null
        }
        const goal = host.revise(current, now, {
          status: 'scheduled',
          schedule: { ...current.schedule, retryAt: now },
          pausedReason: undefined,
        })
        return { goal, result: { event: 'retried' as const, message } }
      }

      if (input.action === 'run_now') {
        if (current.status !== 'scheduled') {
          failure = 'invalid_state'
          return null
        }
        const goal = host.revise(current, now, {
          schedule: { ...current.schedule, retryAt: now },
        })
        return {
          goal,
          result: { event: 'run_requested' as const, message },
        }
      }

      if (
        current.status !== 'scheduled' &&
        current.status !== 'paused' &&
        current.status !== 'failed'
      ) {
        failure = 'invalid_state'
        return null
      }
      const goal = host.revise(current, now, {
        status: 'cancelled',
        pausedReason: message || 'Cancelled by control plane.',
      })
      return { goal, result: { event: 'cancelled' as const, message } }
    })
    if (!changed) return { ok: false, reason: failure ?? 'not_found' }

    host.emit({
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
 * Updates an idle goal definition with optimistic concurrency. A live lease
 * or GoalRun always wins: callers must pause the run before editing it.
 */
export function updateScheduleForControlPlaneImpl(
  host: GoalControlPlaneHost,
  input: ControlPlaneGoalScheduleUpdateInput,
): ControlPlaneGoalScheduleUpdateResult {
  let cwd: string
  let sessionId: string
  let scheduleId: string
  let objective: string | undefined
  let acceptanceCriteria: string[] | undefined
  let maxIterations: number | undefined
  try {
    cwd = resolve(cleanText(input.cwd, 'Goal cwd'))
    sessionId = cleanText(input.sessionId, 'Goal sessionId')
    scheduleId = cleanText(input.scheduleId, 'Schedule ID')
    objective =
      input.objective === undefined
        ? undefined
        : cleanText(input.objective, 'Goal objective', MAX_GOAL_OBJECTIVE_CHARS)
    acceptanceCriteria =
      input.acceptanceCriteria === undefined
        ? undefined
        : cleanCriteria(input.acceptanceCriteria)
    maxIterations =
      input.maxIterations === undefined
        ? undefined
        : normaliseMaxIterations(input.maxIterations)
    if (
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 1 ||
      (objective === undefined &&
        acceptanceCriteria === undefined &&
        maxIterations === undefined &&
        input.schedule === undefined)
    ) {
      return { ok: false, reason: 'invalid_request' }
    }
    if (input.schedule?.kind === 'once') {
      if (
        input.schedule.runAt !== undefined &&
        (!Number.isSafeInteger(input.schedule.runAt) ||
          input.schedule.runAt < 0)
      ) {
        return { ok: false, reason: 'invalid_request' }
      }
    } else if (input.schedule?.kind === 'interval') {
      if (
        !Number.isSafeInteger(input.schedule.everyMs) ||
        input.schedule.everyMs <= 0 ||
        (input.schedule.anchorAt !== undefined &&
          (!Number.isSafeInteger(input.schedule.anchorAt) ||
            input.schedule.anchorAt < 0))
      ) {
        return { ok: false, reason: 'invalid_request' }
      }
    }
  } catch {
    return { ok: false, reason: 'invalid_request' }
  }

  const now = host.now(input.now)
  return host.storage.withScopeLock({ cwd, sessionId }, () => {
    const selected = host.storage
      .listGoals()
      .find(
        goal =>
          goal.cwd === cwd &&
          goal.sessionId === sessionId &&
          goal.schedule.id === scheduleId,
      )
    if (!selected) return { ok: false, reason: 'not_found' }

    let failure:
      | Exclude<ControlPlaneGoalScheduleUpdateResult, { ok: true }>['reason']
      | null = null
    const changed = host.storage.mutateGoal<string[]>(selected.id, current => {
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
      if (
        current.status !== 'scheduled' &&
        current.status !== 'paused' &&
        current.status !== 'failed'
      ) {
        failure = 'invalid_state'
        return null
      }

      const nextObjective = objective ?? current.objective
      let schedule: Schedule = {
        ...current.schedule,
        prompt: nextObjective,
      }
      if (input.schedule) {
        const lastClaimedAt = current.schedule.lastClaimedAt
        // A recovered interrupted run is a separate one-off slot consumed
        // before the next regular run. Rebuilding the schedule must not drop
        // it, or the pending retry would be silently lost.
        const pendingRetryAt = current.schedule.retryAt
        try {
          const scheduleInput: ScheduleInput =
            input.schedule.kind === 'once'
              ? {
                  kind: 'once',
                  prompt: nextObjective,
                  runAt: input.schedule.runAt ?? now,
                }
              : {
                  kind: 'interval',
                  prompt: nextObjective,
                  everyMs: input.schedule.everyMs,
                  anchorAt:
                    input.schedule.anchorAt ??
                    nextDeferredIntervalAt(now, input.schedule.everyMs),
                }
          schedule = host.createSchedule({
            input: scheduleInput,
            goalId: current.id,
            cwd,
            sessionId,
            now,
          })
          schedule.id = current.schedule.id
          if (lastClaimedAt !== undefined)
            schedule.lastClaimedAt = lastClaimedAt
          if (pendingRetryAt !== undefined) schedule.retryAt = pendingRetryAt
        } catch {
          failure = 'invalid_request'
          return null
        }
      }

      const fields: string[] = []
      if (objective !== undefined) fields.push('objective')
      if (acceptanceCriteria !== undefined) fields.push('acceptanceCriteria')
      if (maxIterations !== undefined) fields.push('maxIterations')
      if (input.schedule !== undefined) fields.push('schedule')
      const goal = host.revise(current, now, {
        objective: nextObjective,
        acceptanceCriteria: acceptanceCriteria ?? current.acceptanceCriteria,
        schedule,
        loop: {
          ...current.loop,
          maxIterations: maxIterations ?? current.loop.maxIterations,
        },
      })
      return { goal, result: fields }
    })
    if (!changed) return { ok: false, reason: failure ?? 'not_found' }

    host.emit({
      goal: changed.goal,
      type: 'updated',
      at: now,
      from: changed.before.status,
      to: changed.goal.status,
      message: `Updated ${changed.result.join(', ')}.`,
      data: { fields: changed.result },
    })
    return { ok: true, goal: changed.goal }
  })
}

/** Returns a bounded, session-scoped event journal for one schedule. */
export function listScheduleEventsForControlPlaneImpl(
  host: GoalControlPlaneHost,
  input: {
    cwd: string
    sessionId: string
    scheduleId: string
    limit: number
  },
): GoalEvent[] | null {
  const cwd = resolve(cleanText(input.cwd, 'Goal cwd'))
  const sessionId = cleanText(input.sessionId, 'Goal sessionId')
  const scheduleId = cleanText(input.scheduleId, 'Schedule ID')
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100
  ) {
    throw new Error('Goal event limit must be an integer between 1 and 100.')
  }
  const selected = host.storage
    .listGoals()
    .find(
      goal =>
        goal.cwd === cwd &&
        goal.sessionId === sessionId &&
        goal.schedule.id === scheduleId,
    )
  if (!selected) return null
  return host.storage.listEvents(selected.id, { limit: input.limit })
}
