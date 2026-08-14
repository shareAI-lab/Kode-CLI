import type { Goal } from './types'

/**
 * Stored on an interval Goal only after the user explicitly asks its host to
 * stay alive outside the foreground CLI session.
 */
export const BACKGROUND_KEEP_ALIVE_METADATA_KEY = 'backgroundKeepAlive'

/**
 * Keeps the opt-in boundary in one place so an arbitrary Goal metadata field
 * cannot accidentally turn a one-off or ordinary scheduled Goal into an
 * unattended background task.
 */
export function isBackgroundKeepAliveGoal(
  goal: Pick<Goal, 'metadata' | 'schedule'>,
): boolean {
  return (
    goal.schedule.kind === 'interval' &&
    goal.metadata?.[BACKGROUND_KEEP_ALIVE_METADATA_KEY] === true
  )
}
