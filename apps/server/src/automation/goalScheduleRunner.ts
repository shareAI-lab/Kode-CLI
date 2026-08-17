import { GoalScheduler, GoalService, type ClaimedSchedule } from '@kode/goals'

import type { DaemonSession } from '../ws/types'

export type GoalScheduleRunnerOptions = {
  listSessions: () => Iterable<DaemonSession>
  canDispatch: (session: DaemonSession) => boolean
  /**
   * A detached session must claim only schedules that explicitly opted into
   * background keep-alive; foreground sessions retain normal scheduling.
   */
  isBackgroundSession?: (session: DaemonSession) => boolean
  dispatch: (args: {
    session: DaemonSession
    schedule: ClaimedSchedule
  }) => Promise<void>
  service?: GoalService
  scheduler?: GoalScheduler
  pollIntervalMs?: number
  onError?: (error: unknown) => void
}

const DEFAULT_POLL_INTERVAL_MS = 1_000

/**
 * Bridges durable schedule claims to an already-connected daemon session.
 * It never invents an offline session or bypasses the normal tool-permission
 * path: hosts decide whether a session is eligible before a schedule is claimed.
 */
export class GoalScheduleRunner {
  private readonly service: GoalService
  private readonly scheduler: GoalScheduler
  private readonly pollIntervalMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false

  constructor(private readonly options: GoalScheduleRunnerOptions) {
    this.service = options.service ?? new GoalService()
    this.scheduler = options.scheduler ?? new GoalScheduler(this.service)
    const configured = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.pollIntervalMs = Number.isFinite(configured)
      ? Math.max(100, Math.floor(configured))
      : DEFAULT_POLL_INTERVAL_MS
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.tick()
    }, this.pollIntervalMs)
    this.timer.unref?.()
    void this.tick()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const dispatches: Promise<void>[] = []
      for (const session of this.options.listSessions()) {
        if (!this.options.canDispatch(session)) continue
        const backgroundOnly =
          this.options.isBackgroundSession?.(session) === true
        const schedules = this.scheduler.tick({
          cwd: session.cwd,
          sessionId: session.sessionId,
          ...(backgroundOnly ? { backgroundOnly: true } : {}),
        })
        for (const schedule of schedules) {
          dispatches.push(
            this.options.dispatch({ session, schedule }).then(
              () => {
                // The normal engine pipeline applies a terminal evaluator
                // decision before dispatch returns. Echo/test transports
                // and defensive host adapters may return without doing so;
                // never leave that claimed run stuck until its lease
                // expires. runId fencing makes this a no-op when the engine
                // already completed, paused, or replaced it.
                this.service.releaseAfterTurn(schedule.goalId, {
                  runId: schedule.runId,
                  reason:
                    'Scheduled turn returned without a terminal goal decision.',
                })
              },
              error => {
                // Do not leave a claimed run silently stuck. Interval
                // schedules are released to their next cadence; one-off runs
                // pause for review.
                this.service.releaseAfterTurn(schedule.goalId, {
                  runId: schedule.runId,
                  reason: `Scheduled dispatch failed: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                })
                this.options.onError?.(error)
              },
            ),
          )
        }
      }
      // Dispatch is the slow part (an LLM turn); run independent sessions in
      // parallel instead of serializing them behind the first session's turn.
      await Promise.allSettled(dispatches)
    } catch (error) {
      // A claim/storage failure must never escape as an unhandled rejection:
      // `start()` fires `void this.tick()` from a timer, and Bun terminates
      // the process on an unhandled rejection. Route the failure to the
      // host's error sink instead of killing the daemon.
      this.options.onError?.(error)
    } finally {
      this.ticking = false
    }
  }
}
