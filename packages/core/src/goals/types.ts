/**
 * Durable goal state is intentionally independent from the existing lightweight
 * Task list. A goal owns a session-bound execution loop, schedule and proof of
 * its state transitions.
 */

export const GOAL_SCHEMA_VERSION = 1 as const

export type GoalStatus =
  | 'scheduled'
  | 'running'
  | 'awaiting_approval'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type GoalScheduleKind = 'once' | 'interval'

type ScheduleBase = {
  /** Stable ID for auditing and future multi-schedule support. */
  id: string
  goalId: string
  cwd: string
  sessionId: string
  /** Text that a UI/runtime should submit when this schedule is claimed. */
  prompt: string
  /** The next regular due time. `null` means the regular schedule is exhausted. */
  nextRunAt: number | null
  /** One recovered interrupted run. It is consumed before the next regular run. */
  retryAt?: number
  lastClaimedAt?: number
}

export type OnceSchedule = ScheduleBase & {
  kind: 'once'
  runAt: number
}

export type IntervalSchedule = ScheduleBase & {
  kind: 'interval'
  /** Fixed cadence in milliseconds. */
  everyMs: number
  /** Fixed cadence anchor; missed slots are skipped rather than replayed. */
  anchorAt: number
}

/**
 * A schedule is returned by `claimDueSchedules`. It carries its prompt and
 * session routing information so a TUI/daemon can wake the correct session.
 */
export type Schedule = OnceSchedule | IntervalSchedule

/**
 * A schedule that has been atomically claimed for one concrete GoalRun.
 * Callers which complete or release the run must return this runId as a
 * fencing token so an expired/reclaimed run cannot mutate its successor.
 */
export type ClaimedSchedule = Schedule & {
  runId: string
}

export type ScheduleInput =
  | {
      kind: 'once'
      prompt: string
      runAt?: number
    }
  | {
      kind: 'interval'
      prompt: string
      everyMs: number
      anchorAt?: number
    }

export type GoalLease = {
  ownerId: string
  runId: string
  acquiredAt: number
  expiresAt: number
}

export type ActiveGoalRun = {
  id: string
  scheduleId: string
  scheduledFor: number
  startedAt: number
  turnCount: number
}

export type GoalLoop = {
  /** Maximum evaluator-approved continuation turns for one claimed run. */
  maxIterations: number
  /** Used when an evaluator asks the engine to continue without custom text. */
  continuationPrompt: string
}

export type GoalError = {
  code: string
  message: string
  at: number
}

export type Goal = {
  schemaVersion: typeof GOAL_SCHEMA_VERSION
  id: string
  cwd: string
  sessionId: string
  objective: string
  acceptanceCriteria: string[]
  status: GoalStatus
  schedule: Schedule
  loop: GoalLoop
  revision: number
  createdAt: number
  updatedAt: number
  completedAt?: number
  pausedReason?: string
  lastError?: GoalError
  lease?: GoalLease
  activeRun?: ActiveGoalRun
  metadata?: Record<string, unknown>
}

export type CreateGoalInput = {
  /** Optional deterministic ID for import/tests. Normal callers receive a UUID. */
  id?: string
  cwd: string
  sessionId: string
  objective: string
  acceptanceCriteria?: string[]
  schedule: ScheduleInput
  loop?: Partial<GoalLoop>
  metadata?: Record<string, unknown>
}

/**
 * The deliberately small schedule shape accepted by the daemon control plane.
 * Routing identity, prompt text, loop settings, metadata and GoalRun fencing
 * are server-owned and therefore intentionally absent here.
 */
export type ControlPlaneGoalScheduleInput =
  | {
      kind: 'once'
      runAt?: number
    }
  | {
      kind: 'interval'
      everyMs: number
      anchorAt?: number
    }

export type CreateScheduledGoalControlPlaneInput = {
  cwd: string
  sessionId: string
  objective: string
  acceptanceCriteria?: string[]
  schedule: ControlPlaneGoalScheduleInput
}

/**
 * Durable schedule state changes exposed to the daemon control plane. These
 * actions intentionally cannot start work or alter a prompt, workspace,
 * session, loop, or workflow definition.
 */
export type ControlPlaneGoalScheduleAction = 'pause' | 'resume' | 'cancel'

export type ControlPlaneGoalScheduleTransitionInput = {
  cwd: string
  sessionId: string
  scheduleId: string
  expectedRevision: number
  action: ControlPlaneGoalScheduleAction
  reason?: string
  /** Test/embedded-runtime override. HTTP callers never supply this. */
  now?: number
}

export type ControlPlaneGoalScheduleTransitionResult =
  | { ok: true; goal: Goal }
  | {
      ok: false
      reason:
        | 'not_found'
        | 'revision_conflict'
        | 'active_run'
        | 'invalid_state'
        | 'invalid_request'
    }

export type GoalEventType =
  | 'created'
  | 'claimed'
  | 'continued'
  | 'released'
  | 'completed'
  | 'paused'
  | 'failed'
  | 'cancelled'
  | 'approval_requested'
  | 'recovered'

export type GoalEvent = {
  id: string
  goalId: string
  type: GoalEventType
  at: number
  revision: number
  from?: GoalStatus
  to?: GoalStatus
  message?: string
  data?: Record<string, unknown>
}

export type GoalTurnEvaluation = {
  action: 'continue' | 'complete' | 'paused' | 'none'
  reason?: string
  continuationPrompt?: string
}

export type GoalTurnEvaluator = (input: {
  goal: Goal
  cwd: string
  sessionId: string
  assistantText: string
  signal?: AbortSignal
}) => Promise<GoalTurnEvaluation>

export type GoalTurnEvaluationResult = {
  action: 'continue' | 'complete' | 'none' | 'paused' | 'expired'
  goal?: Goal
  continuationPrompt?: string
  reason?: string
}

export type Clock = {
  now(): number
}

export const systemClock: Clock = {
  now: () => Date.now(),
}

export type ClaimDueSchedulesInput = {
  cwd: string
  sessionId: string
  /** Internal/direct-start selector. Normal pollers claim the next due goal. */
  goalId?: string
  now?: number
  ownerId?: string
  leaseDurationMs?: number
  /** Claim at most this many due schedules in one host tick. */
  limit?: number
  /** Test/embedded-runtime override; defaults to the KODE root. */
  rootDir?: string
}

export type RecoverInterruptedGoalsInput = {
  /** Restrict recovery to one workspace/session when a host is polling it. */
  cwd?: string
  sessionId?: string
  now?: number
  /** Test/embedded-runtime override; defaults to the KODE root. */
  rootDir?: string
}

export type GoalStorageOptions = {
  /** Defaults to the current KODE root. Primarily useful for tests. */
  rootDir?: string
}

export type GoalServiceOptions = GoalStorageOptions & {
  clock?: Clock
  leaseDurationMs?: number
  idFactory?: () => string
}
