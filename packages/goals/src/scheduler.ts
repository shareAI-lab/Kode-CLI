import { GoalService } from './service'
import {
  type ClaimedSchedule,
  type ClaimDueSchedulesInput,
  type Goal,
  type GoalSchedulePollResult,
} from './types'

/**
 * A direct `/goal` call claims its one-off run immediately so duplicate starts
 * cannot race. Hosts still need a prompt to begin that claimed run. Surface it
 * once while it has no completed turn, without changing its fencing token.
 */
export function getUnstartedGoalRunSchedule(
  goal: Goal | null,
): ClaimedSchedule | null {
  if (
    !goal ||
    goal.status !== 'running' ||
    goal.schedule.kind !== 'once' ||
    goal.activeRun?.turnCount !== 0
  ) {
    return null
  }

  const runId = goal.activeRun.id
  if (goal.lease?.runId !== runId) return null
  return { ...goal.schedule, runId }
}

/**
 * Pure, durable schedule claim primitive. It deliberately does not execute an
 * LLM or submit messages: callers (REPL/daemon) take the returned prompt and
 * choose how to deliver it to the target session.
 */
export function claimDueSchedules(
  input: ClaimDueSchedulesInput,
): ClaimedSchedule[] {
  const service = new GoalService({
    rootDir: input.rootDir,
    clock: {
      now: () => (typeof input.now === 'number' ? input.now : Date.now()),
    },
    leaseDurationMs: input.leaseDurationMs,
  })
  const now = service.clock.now()
  // Recovery creates one retry slot for an interrupted run. It never rewinds
  // an interval, so a downtime cannot produce a catch-up burst.
  service.recoverInterruptedGoals({
    now,
    cwd: input.cwd,
    sessionId: input.sessionId,
  })
  return service.claimDueSchedules(input)
}

/** One-scan polling primitive for interactive and daemon scheduler hot paths. */
export function pollGoalSchedule(
  input: ClaimDueSchedulesInput,
): GoalSchedulePollResult | null {
  const service = new GoalService({
    rootDir: input.rootDir,
    clock: {
      now: () => (typeof input.now === 'number' ? input.now : Date.now()),
    },
    leaseDurationMs: input.leaseDurationMs,
  })
  return service.pollDueSchedule(input)
}

/**
 * Stateful convenience for pollers. `tick` is synchronous and single-flight;
 * a UI can safely call it from an interval without spawning work itself.
 */
export class GoalScheduler {
  private ticking = false

  constructor(private readonly service: GoalService = new GoalService()) {}

  tick(input: Omit<ClaimDueSchedulesInput, 'rootDir'>): ClaimedSchedule[] {
    if (this.ticking) return []
    this.ticking = true
    try {
      const result = this.service.pollDueSchedule(input)
      return result ? [result.schedule] : []
    } finally {
      this.ticking = false
    }
  }
}
