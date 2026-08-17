import type { Command } from '../types'

import { GoalService, type GoalEvent } from '#core/goals'
import { getCwd } from '#core/utils/state'
import { getKodeAgentSessionId } from '#protocol/utils/kodeAgentSessionId'

const USAGE =
  'Usage: /automation recover | /automation status | /automation events <goal-id>'

export function formatAutomationEvent(event: GoalEvent): string {
  const transition =
    event.from || event.to ? ` ${event.from ?? '?'}→${event.to ?? '?'}` : ''
  const message = event.message ? ` — ${event.message}` : ''
  return `${new Date(event.at).toISOString()} ${event.type}${transition}${message}`
}

function sessionGoals(service: GoalService) {
  const cwd = getCwd()
  const sessionId = getKodeAgentSessionId()
  return service
    .listGoals()
    .filter(goal => goal.cwd === cwd && goal.sessionId === sessionId)
    .sort((a, b) => b.updatedAt - a.updatedAt || b.revision - a.revision)
}

function isGoalInCurrentSession(goal: {
  cwd: string
  sessionId: string
}): boolean {
  return goal.cwd === getCwd() && goal.sessionId === getKodeAgentSessionId()
}

const automation = {
  type: 'local',
  name: 'automation',
  description: 'Recover interrupted goals and inspect durable automation state',
  argumentHint: '[recover | status | events <goal-id>]',
  isEnabled: true,
  isHidden: true,
  async call(args) {
    const raw = args.trim()
    const [verbRaw, ...rest] = raw.split(/\s+/)
    const verb = verbRaw?.toLowerCase() || 'status'
    const service = new GoalService()

    try {
      if (verb === 'recover') {
        const recovered = service.recoverInterruptedGoals({
          cwd: getCwd(),
          sessionId: getKodeAgentSessionId(),
        })
        if (recovered.length === 0)
          return 'No interrupted GoalRun leases required recovery.'
        return [
          `Recovered ${recovered.length} interrupted goal${recovered.length === 1 ? '' : 's'}:`,
          ...recovered.map(
            goal => `${goal.id}  retry scheduled  ${goal.objective}`,
          ),
        ].join('\n')
      }

      if (verb === 'events') {
        const goalId = rest[0]?.trim()
        if (!goalId) return `${USAGE}\nA goal ID is required for events.`
        const goal = service.getGoal(goalId)
        if (!goal || !isGoalInCurrentSession(goal)) {
          return `No goal found for this session: ${goalId}`
        }
        const events = service.listGoalEvents(goalId)
        if (events.length === 0) return `No events found for goal: ${goalId}`
        return events.map(formatAutomationEvent).join('\n')
      }

      if (verb === 'status') {
        const goals = sessionGoals(service)
        if (goals.length === 0)
          return 'No durable automation state for this session.'
        const counts = new Map<string, number>()
        for (const goal of goals) {
          counts.set(goal.status, (counts.get(goal.status) ?? 0) + 1)
        }
        const summary = [...counts.entries()]
          .map(([status, count]) => `${status}: ${count}`)
          .join(', ')
        return [
          `Automation status (${summary})`,
          ...goals.map(goal => {
            const next =
              goal.schedule.nextRunAt === null
                ? '—'
                : new Date(goal.schedule.nextRunAt).toISOString()
            return `${goal.id}  ${goal.status}  next=${next}  ${goal.objective}`
          }),
        ].join('\n')
      }

      return USAGE
    } catch (error) {
      return `Automation error: ${error instanceof Error ? error.message : String(error)}`
    }
  },
  userFacingName() {
    return 'automation'
  },
} satisfies Command

export default automation
