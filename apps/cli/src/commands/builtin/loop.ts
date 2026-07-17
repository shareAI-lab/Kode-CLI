import type { Command } from '../types'

import { GoalService, type Goal } from '#core/goals'
import { getCwd } from '#core/utils/state'
import { getKodeAgentSessionId } from '#protocol/utils/kodeAgentSessionId'

import { formatGoalStatus } from './goal'
import {
  createIntervalGoal,
  parseEveryInterval,
  parseLoopCreateArgs,
} from './goalSchedule'

export { parseEveryInterval, parseLoopCreateArgs }

const USAGE =
  'Usage: /loop [start] <objective> --every 30s|5m|1h | /loop status [goal-id] | /loop cancel <goal-id>'

function currentScope(): { cwd: string; sessionId: string } {
  return { cwd: getCwd(), sessionId: getKodeAgentSessionId() }
}

function sessionLoops(service: GoalService): Goal[] {
  const { cwd, sessionId } = currentScope()
  return service
    .listGoals()
    .filter(
      goal =>
        goal.cwd === cwd &&
        goal.sessionId === sessionId &&
        goal.schedule.kind === 'interval',
    )
    .sort((a, b) => b.updatedAt - a.updatedAt || b.revision - a.revision)
}

function findSessionLoop(service: GoalService, goalId: string): Goal | null {
  const goal = service.getGoal(goalId)
  if (!goal || goal.schedule.kind !== 'interval') return null
  const { cwd, sessionId } = currentScope()
  return goal.cwd === cwd && goal.sessionId === sessionId ? goal : null
}

function commandError(error: unknown): string {
  return `Loop error: ${error instanceof Error ? error.message : String(error)}`
}

const loop = {
  type: 'local',
  name: 'loop',
  description: 'Create and manage durable fixed-interval goal prompts',
  argumentHint: '[start <objective> --every 5m | status [id] | cancel <id>]',
  isEnabled: true,
  isHidden: false,
  async call(args) {
    const raw = args.trim()
    if (!raw) return USAGE
    const [verbRaw, ...rest] = raw.split(/\s+/)
    const verb = verbRaw?.toLowerCase() ?? ''

    try {
      if (verb === 'status') {
        const requestedId = rest[0]?.trim()
        const service = new GoalService()
        const goal = requestedId
          ? findSessionLoop(service, requestedId)
          : (sessionLoops(service)[0] ?? null)
        if (!goal) return 'No interval loop found for this session.'
        if (goal.schedule.kind !== 'interval') {
          return `Goal ${goal.id} is not an interval loop.`
        }
        return formatGoalStatus(goal)
      }

      if (verb === 'cancel') {
        const goalId = rest[0]?.trim()
        if (!goalId) return `${USAGE}\nA loop goal ID is required for cancel.`
        const service = new GoalService()
        const existing = findSessionLoop(service, goalId)
        if (!existing) {
          return `Interval loop not found for this session: ${goalId}`
        }
        const cancelled = service.cancelGoal(goalId, {
          reason: 'Cancelled with /loop.',
        })
        return cancelled
          ? formatGoalStatus(cancelled)
          : `Goal not found: ${goalId}`
      }

      const createRaw = verb === 'start' ? rest.join(' ') : raw
      const parsed = parseLoopCreateArgs(createRaw)
      if ('error' in parsed) return `${USAGE}\n${parsed.error}`
      const { cwd, sessionId } = currentScope()
      const now = Date.now()
      const created = createIntervalGoal({
        cwd,
        sessionId,
        objective: parsed.objective,
        everyMs: parsed.everyMs,
        now,
      })
      return [
        `Loop created: ${created.id}`,
        `Every: ${parsed.everyMs}ms`,
        `Next run: ${new Date(created.schedule.nextRunAt ?? now).toISOString()}`,
        `Prompt: ${created.schedule.prompt}`,
      ].join('\n')
    } catch (error) {
      return commandError(error)
    }
  },
  userFacingName() {
    return 'loop'
  },
} satisfies Command

export default loop
