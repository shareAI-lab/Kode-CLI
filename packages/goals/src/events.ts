import { randomUUID } from 'node:crypto'

import {
  MAX_GOAL_REASON_CHARS,
  type Goal,
  type GoalEvent,
  type GoalEventType,
  type GoalStatus,
} from './types'
import { GoalStorage } from './storage'

export function createGoalEvent(args: {
  goal: Goal
  type: GoalEventType
  at: number
  from?: GoalStatus
  to?: GoalStatus
  message?: string
  data?: Record<string, unknown>
}): GoalEvent {
  const message = args.message?.trim()
  if (message && message.length > MAX_GOAL_REASON_CHARS) {
    throw new Error(
      `Goal event message cannot exceed ${MAX_GOAL_REASON_CHARS} characters.`,
    )
  }
  return {
    id: randomUUID(),
    goalId: args.goal.id,
    type: args.type,
    at: args.at,
    revision: args.goal.revision,
    ...(args.from ? { from: args.from } : {}),
    ...(args.to ? { to: args.to } : {}),
    ...(message ? { message } : {}),
    ...(args.data ? { data: args.data } : {}),
  }
}

export function appendGoalEvent(
  storage: GoalStorage,
  args: Parameters<typeof createGoalEvent>[0],
): GoalEvent {
  const event = createGoalEvent(args)
  storage.appendEvent(event)
  return event
}
