import { GoalService, isBackgroundKeepAliveGoal, type Goal } from '@kode/goals'

import { SessionRegistry } from '../sessionRegistry'
import type { DaemonSession } from '../ws/types'

function isLiveBackgroundLoop(goal: Goal): boolean {
  // A lease may survive an unexpected daemon exit. Keep its session available
  // so the normal scheduler recovery path can release it after the lease
  // expires; paused/cancelled loops must never wake a detached daemon.
  return (
    isBackgroundKeepAliveGoal(goal) &&
    (goal.status === 'scheduled' || goal.status === 'running')
  )
}

/**
 * Resolves only explicitly background-enabled interval loops into daemon
 * sessions. A session with no transcript yet is valid: the first background
 * turn will create its durable transcript through the usual chat handler.
 */
export class BackgroundLoopSessions {
  constructor(
    private readonly options: {
      service: GoalService
      sessionRegistry: SessionRegistry
    },
  ) {}

  list(): DaemonSession[] {
    const sessions = new Map<string, DaemonSession>()
    for (const goal of this.options.service.listGoals()) {
      if (!isLiveBackgroundLoop(goal)) continue
      let existing: ReturnType<SessionRegistry['getOrLoad']>
      try {
        existing = this.options.sessionRegistry.getOrLoad({
          cwd: goal.cwd,
          sessionId: goal.sessionId,
        })
      } catch {
        // Goal storage accepts legacy session IDs, while daemon persistence
        // requires UUID session IDs. A malformed legacy record must not stop
        // unrelated background loops from being restored.
        continue
      }
      const session = existing.ok
        ? existing.session
        : existing.reason === 'not_found'
          ? this.options.sessionRegistry.createFromMessages({
              cwd: goal.cwd,
              sessionId: goal.sessionId,
              messages: [],
            })
          : null
      if (session) sessions.set(session.sessionId, session)
    }
    return Array.from(sessions.values())
  }

  has(session: DaemonSession): boolean {
    return this.options.service
      .listGoals()
      .some(
        goal =>
          goal.cwd === session.cwd &&
          goal.sessionId === session.sessionId &&
          isLiveBackgroundLoop(goal),
      )
  }
}
