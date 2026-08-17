import type { Command } from '../types'

import {
  GoalService,
  MAX_GOAL_ACCEPTANCE_CRITERIA,
  MAX_GOAL_CONTINUATIONS,
  startGoal,
  type Goal,
  type GoalStatus,
} from '#core/goals'
import { getCwd } from '#core/utils/state'
import { getKodeAgentSessionId } from '#protocol/utils/kodeAgentSessionId'

const USAGE =
  'Usage: /goal [start] <objective> [--accept <criterion>] [--max-iterations <1-64>] | /goal edit <goal-id> <objective> [options] | /goal status|history|stats [goal-id] | /goal pause|resume|retry|run|cancel <goal-id> | /goal list'

function formatTimestamp(value: number | null | undefined): string {
  if (typeof value !== 'number') return '—'
  return new Date(value).toISOString()
}

function formatSchedule(goal: Goal): string {
  const schedule = goal.schedule
  if (schedule.kind === 'once') {
    return `once at ${formatTimestamp(schedule.runAt)}`
  }
  return `every ${schedule.everyMs}ms (next ${formatTimestamp(schedule.nextRunAt)})`
}

export function formatGoalStatus(goal: Goal): string {
  const lines = [
    `Goal ${goal.id}`,
    `Status: ${goal.status}`,
    `Objective: ${goal.objective}`,
    `Schedule: ${formatSchedule(goal)}`,
    `Prompt: ${goal.schedule.prompt}`,
    `Continuation limit: ${goal.loop.maxIterations}`,
    `Progress: ${goal.activeRun?.turnCount ?? 0}/${goal.loop.maxIterations} continuations`,
    `Session: ${goal.sessionId}`,
    `Revision: ${goal.revision}`,
    `Updated: ${formatTimestamp(goal.updatedAt)}`,
  ]
  if (goal.acceptanceCriteria.length > 0) {
    lines.push(`Acceptance: ${goal.acceptanceCriteria.join('; ')}`)
  }
  if (goal.pausedReason) lines.push(`Reason: ${goal.pausedReason}`)
  if (goal.lastError) {
    lines.push(
      `Last error: ${goal.lastError.message} (${formatTimestamp(goal.lastError.at)})`,
    )
  }
  return lines.join('\n')
}

function currentScope(): { cwd: string; sessionId: string } {
  return { cwd: getCwd(), sessionId: getKodeAgentSessionId() }
}

function sessionGoals(service: GoalService): Goal[] {
  const { cwd, sessionId } = currentScope()
  return service
    .listGoals()
    .filter(goal => goal.cwd === cwd && goal.sessionId === sessionId)
    .sort((a, b) => b.updatedAt - a.updatedAt || b.revision - a.revision)
}

function findSessionGoal(service: GoalService, goalId: string): Goal | null {
  const goal = service.getGoal(goalId)
  if (!goal) return null
  const { cwd, sessionId } = currentScope()
  return goal.cwd === cwd && goal.sessionId === sessionId ? goal : null
}

type GoalStartArgs = {
  objective: string
  acceptanceCriteria: string[]
  maxIterations?: number
}

const START_OPTION_PATTERN =
  /(?:^|\s)--(accept|max-iterations)(?:(=)|(?=\s|$))/gi

function unquoteOptionValue(value: string): string {
  const trimmed = value.trim()
  const first = trimmed[0]
  if (
    trimmed.length >= 2 &&
    (first === '"' || first === "'") &&
    trimmed[trimmed.length - 1] === first
  ) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

export function parseGoalStartArgs(
  raw: string,
): GoalStartArgs | { error: string } {
  const matches = Array.from(raw.matchAll(START_OPTION_PATTERN))
  if (matches.length === 0) {
    return { objective: raw.trim(), acceptanceCriteria: [] }
  }

  const objective = raw.slice(0, matches[0]!.index).trim()
  if (!objective) return { error: 'A goal objective is required.' }

  const acceptanceCriteria: string[] = []
  let maxIterations: number | undefined
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!
    const next = matches[index + 1]
    const value = unquoteOptionValue(
      raw.slice(match.index + match[0].length, next?.index ?? raw.length),
    )
    const option = match[1]?.toLowerCase()
    if (option === 'accept') {
      if (!value) return { error: 'Each --accept option needs a criterion.' }
      acceptanceCriteria.push(value)
      continue
    }
    if (maxIterations !== undefined) {
      return { error: 'Use only one --max-iterations option.' }
    }
    if (!/^\d+$/.test(value)) {
      return {
        error: `--max-iterations must be an integer between 1 and ${MAX_GOAL_CONTINUATIONS}.`,
      }
    }
    const parsed = Number(value)
    if (
      !Number.isSafeInteger(parsed) ||
      parsed < 1 ||
      parsed > MAX_GOAL_CONTINUATIONS
    ) {
      return {
        error: `--max-iterations must be an integer between 1 and ${MAX_GOAL_CONTINUATIONS}.`,
      }
    }
    maxIterations = parsed
  }
  if (acceptanceCriteria.length > MAX_GOAL_ACCEPTANCE_CRITERIA) {
    return {
      error: `Use at most ${MAX_GOAL_ACCEPTANCE_CRITERIA} acceptance criteria.`,
    }
  }
  return {
    objective,
    acceptanceCriteria,
    ...(maxIterations !== undefined ? { maxIterations } : {}),
  }
}

function commandError(error: unknown): string {
  return `Goal error: ${error instanceof Error ? error.message : String(error)}`
}

function controlFailure(reason: string): string {
  return reason === 'revision_conflict'
    ? 'Goal changed while the command was running. Inspect it and retry.'
    : reason === 'active_run'
      ? 'Pause the active GoalRun before editing it.'
      : reason === 'invalid_state'
        ? 'This action is not available in the current goal state.'
        : reason === 'invalid_request'
          ? 'The goal update is invalid.'
          : 'Goal not found for this session.'
}

function formatGoalHistory(service: GoalService, goal: Goal, limit: number) {
  const events = service.listGoalEvents(goal.id, { limit })
  if (events.length === 0) return `No events recorded for goal ${goal.id}.`
  return [
    `Goal ${goal.id} history (latest ${events.length})`,
    ...events.map(event => {
      const transition =
        event.from || event.to
          ? ` ${event.from ?? '—'} → ${event.to ?? '—'}`
          : ''
      return `${formatTimestamp(event.at)}  ${event.type}${transition}${event.message ? ` — ${event.message}` : ''}`
    }),
  ].join('\n')
}

const TERMINAL_STATUSES: GoalStatus[] = ['completed', 'failed', 'cancelled']

function formatDurationMs(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

export function formatGoalStats(
  goals: Goal[],
  countContinuations?: (goalId: string) => number,
): string {
  if (goals.length === 0) return 'No goals recorded for this session.'

  const counts = new Map<GoalStatus, number>()
  for (const goal of goals) {
    counts.set(goal.status, (counts.get(goal.status) ?? 0) + 1)
  }
  const completed = goals.filter(goal => goal.status === 'completed')
  const terminal = goals.filter(goal => TERMINAL_STATUSES.includes(goal.status))
  const completionRate =
    terminal.length > 0
      ? Math.round((completed.length / terminal.length) * 100)
      : 0

  const durations = goals.flatMap(goal =>
    goal.completedAt !== undefined ? [goal.completedAt - goal.createdAt] : [],
  )
  const averageDuration =
    durations.length > 0
      ? durations.reduce((sum, value) => sum + value, 0) / durations.length
      : null

  const turnCounts = completed.flatMap(goal =>
    countContinuations !== undefined
      ? [countContinuations(goal.id)]
      : [goal.loop.maxIterations],
  )
  const averageContinuations =
    turnCounts.length > 0
      ? turnCounts.reduce((sum, value) => sum + value, 0) / turnCounts.length
      : null

  const statusSummary = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([status, count]) => `${status} ${count}`)
    .join(' · ')

  const lines = ['Goal statistics', `Total: ${goals.length} · ${statusSummary}`]
  if (terminal.length > 0) {
    lines.push(`Completion rate: ${completionRate}%`)
  }
  if (averageDuration !== null) {
    lines.push(`Avg completion time: ${formatDurationMs(averageDuration)}`)
  }
  if (averageContinuations !== null) {
    lines.push(`Avg continuations: ${averageContinuations.toFixed(1)}`)
  }
  return lines.join('\n')
}

const goal = {
  type: 'local',
  name: 'goal',
  description:
    'Start, edit, inspect, run, retry, pause, or cancel a durable session goal',
  argumentHint:
    '[start <objective> | edit <id> <objective> | status|history|stats [id] | pause|resume|retry|run|cancel <id> | list]',
  isEnabled: true,
  isHidden: true,
  aliases: ['goals'],
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
          ? findSessionGoal(service, requestedId)
          : (service.findActiveGoal(currentScope()) ??
            sessionGoals(service)[0] ??
            null)
        return goal ? formatGoalStatus(goal) : 'No goal found for this session.'
      }

      if (verb === 'list') {
        const goals = sessionGoals(new GoalService())
        if (goals.length === 0) return 'No durable goals for this session.'
        return goals
          .map(goal => `${goal.id}  ${goal.status}  ${goal.objective}`)
          .join('\n')
      }

      if (verb === 'history') {
        const service = new GoalService()
        const requestedId = rest[0]?.trim()
        const selected = requestedId
          ? findSessionGoal(service, requestedId)
          : (service.findActiveGoal(currentScope()) ??
            sessionGoals(service)[0] ??
            null)
        if (!selected) return 'No goal found for this session.'
        const limitRaw = rest[1]
        const limit = limitRaw === undefined ? 20 : Number(limitRaw)
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
          return 'History limit must be an integer between 1 and 100.'
        }
        return formatGoalHistory(service, selected, limit)
      }

      if (verb === 'stats') {
        const service = new GoalService()
        const requestedId = rest[0]?.trim()
        const goals = requestedId
          ? [findSessionGoal(service, requestedId)].filter(
              (goal): goal is Goal => goal !== null,
            )
          : sessionGoals(service)
        if (requestedId && goals.length === 0) {
          return `Goal not found for this session: ${requestedId}`
        }
        return formatGoalStats(
          goals,
          goalId =>
            service
              .listGoalEvents(goalId, {
                limit: MAX_GOAL_CONTINUATIONS + 10,
              })
              .filter(event => event.type === 'continued').length,
        )
      }

      if (verb === 'edit') {
        const goalId = rest[0]?.trim()
        if (!goalId) return `${USAGE}\nA goal ID is required for edit.`
        const service = new GoalService()
        const selected = findSessionGoal(service, goalId)
        if (!selected) return `Goal not found for this session: ${goalId}`
        const editRaw = rest.slice(1).join(' ')
        const parsed = parseGoalStartArgs(editRaw)
        if ('error' in parsed || !parsed.objective) {
          return `${USAGE}\n${'error' in parsed ? parsed.error : 'A new objective is required.'}`
        }
        const includesAcceptance = /(?:^|\s)--accept(?:(?:=)|(?=\s|$))/i.test(
          editRaw,
        )
        const result = service.updateScheduleForControlPlane({
          ...currentScope(),
          scheduleId: selected.schedule.id,
          expectedRevision: selected.revision,
          objective: parsed.objective,
          ...(includesAcceptance
            ? { acceptanceCriteria: parsed.acceptanceCriteria }
            : {}),
          ...(parsed.maxIterations !== undefined
            ? { maxIterations: parsed.maxIterations }
            : {}),
        })
        return result.ok
          ? formatGoalStatus(result.goal)
          : `Goal error: ${controlFailure(result.reason)}`
      }

      if (
        verb === 'cancel' ||
        verb === 'pause' ||
        verb === 'resume' ||
        verb === 'retry' ||
        verb === 'run' ||
        verb === 'run-now'
      ) {
        const goalId = rest[0]?.trim()
        if (!goalId) return `${USAGE}\nA goal ID is required for ${verb}.`
        const service = new GoalService()
        const selected = findSessionGoal(service, goalId)
        if (!selected) {
          return `Goal not found for this session: ${goalId}`
        }
        if (verb === 'resume' && selected.status !== 'paused') {
          return 'Goal error: Resume is available only for paused goals.'
        }
        if (verb === 'retry' && selected.status !== 'failed') {
          return 'Goal error: Retry is available only for failed goals.'
        }
        if (
          verb === 'cancel' &&
          (selected.status === 'completed' || selected.status === 'cancelled')
        ) {
          return 'Goal error: Completed and cancelled goals are terminal.'
        }
        if (
          (verb === 'run' || verb === 'run-now') &&
          selected.status !== 'scheduled'
        ) {
          return 'Goal error: Run is available only for scheduled goals.'
        }
        let updated: Goal | null = null
        if (verb === 'cancel') {
          updated = service.cancelGoal(goalId, {
            reason: 'Cancelled with /goal.',
          })
        } else if (verb === 'pause') {
          updated = service.pauseGoal(goalId, { reason: 'Paused with /goal.' })
        } else {
          const action =
            verb === 'resume'
              ? 'resume'
              : verb === 'retry'
                ? 'retry'
                : 'run_now'
          const result = service.transitionScheduleForControlPlane({
            ...currentScope(),
            scheduleId: selected.schedule.id,
            expectedRevision: selected.revision,
            action,
            reason: `${verb} requested with /goal.`,
          })
          if (!result.ok) return `Goal error: ${controlFailure(result.reason)}`
          updated = result.goal
        }
        if (!updated) return `Goal not found: ${goalId}`
        if (
          verb === 'resume' ||
          verb === 'retry' ||
          verb === 'run' ||
          verb === 'run-now'
        ) {
          const { cwd, sessionId } = currentScope()
          service.claimDueSchedules({
            cwd,
            sessionId,
            ownerId: `goal:${sessionId}`,
          })
        }
        return formatGoalStatus(service.getGoal(goalId) ?? updated)
      }

      const startArgs = verb === 'start' ? rest.join(' ') : raw
      const parsed = parseGoalStartArgs(startArgs)
      if ('error' in parsed) return `${USAGE}\n${parsed.error}`
      const { objective, acceptanceCriteria, maxIterations } = parsed
      if (!objective) return USAGE
      const { cwd, sessionId } = currentScope()
      const started = startGoal({
        cwd,
        sessionId,
        objective,
        acceptanceCriteria,
        ...(maxIterations !== undefined ? { maxIterations } : {}),
      })
      return [
        `Goal started and is active for this session: ${started.id}`,
        `Objective: ${started.objective}`,
        `Max continuations: ${started.loop.maxIterations}`,
        'The first goal turn will start automatically when this session is idle.',
      ].join('\n')
    } catch (error) {
      return commandError(error)
    }
  },
  userFacingName() {
    return 'goal'
  },
} satisfies Command

export type GoalCommandStatus = GoalStatus
export default goal
