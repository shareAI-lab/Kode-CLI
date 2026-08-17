import type { Command } from '../types'

import {
  TaskSupervisor,
  buildTaskGraph,
  getCriticalTaskBlockers,
  getReadyTasks,
  type SupervisorRun,
} from '#core/automation'

const USAGE = [
  'Usage:',
  '  /supervisor status',
  '  /supervisor plan [serial|parallel] [--max N]',
  '  /supervisor list',
  '  /supervisor refresh <run-id>',
  '  /supervisor cancel <run-id>',
].join('\n')

function renderRun(run: SupervisorRun): string {
  const group =
    run.state.currentGroupIndex === null
      ? 'none'
      : String(run.state.currentGroupIndex + 1)
  return [
    `Supervisor run ${run.id}`,
    `Status: ${run.state.status}`,
    `Strategy: ${run.plan.strategy} (max parallel ${run.plan.maxParallelism})`,
    `Current group: ${group}`,
    `Groups: ${
      run.plan.groups
        .map(groupItem => `[${groupItem.taskIds.join(', ')}]`)
        .join(' -> ') || 'none'
    }`,
    `Completed: ${run.state.completedTaskIds.join(', ') || 'none'}`,
    ...(run.state.blockedTaskIds.length > 0
      ? [`Blocked: ${run.state.blockedTaskIds.join(', ')}`]
      : []),
    ...(run.state.reason ? [`Reason: ${run.state.reason}`] : []),
  ].join('\n')
}

function parsePlanArgs(
  args: string,
):
  | { strategy: 'serial' | 'parallel'; maxParallelism?: number }
  | { error: string } {
  const tokens = args.trim().split(/\s+/u).filter(Boolean)
  let strategy: 'serial' | 'parallel' = 'parallel'
  let maxParallelism: number | undefined
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (token === 'serial' || token === 'parallel') {
      strategy = token
      continue
    }
    if (token === '--max') {
      const raw = tokens[index + 1]
      if (!raw || !/^\d+$/u.test(raw))
        return { error: '--max requires a positive integer.' }
      const value = Number(raw)
      if (!Number.isSafeInteger(value) || value < 1 || value > 32) {
        return { error: '--max must be an integer from 1 to 32.' }
      }
      maxParallelism = value
      index += 1
      continue
    }
    return { error: `Unknown plan option: ${token}` }
  }
  return { strategy, ...(maxParallelism ? { maxParallelism } : {}) }
}

const supervisor = {
  type: 'local',
  name: 'supervisor',
  description: 'Plan and inspect a durable dependency-aware task supervisor',
  argumentHint: 'status|plan|list|refresh|cancel ...',
  isEnabled: true,
  isHidden: true,
  disableNonInteractive: true,
  async call(args: string) {
    const [verbRaw = 'status', ...rest] = args
      .trim()
      .split(/\s+/u)
      .filter(Boolean)
    const verb = verbRaw.toLowerCase()
    const supervisor = new TaskSupervisor()
    try {
      if (verb === 'status') {
        if (rest.length > 0) return USAGE
        const graph = buildTaskGraph()
        const ready = getReadyTasks(graph)
        const blockers = getCriticalTaskBlockers(graph).slice(0, 5)
        return [
          `Task graph: ${graph.tasks.length} tasks, ${graph.edges.length} dependencies, ${graph.validation.valid ? 'valid' : 'invalid'}`,
          `Ready: ${ready.map(task => task.id).join(', ') || 'none'}`,
          `Critical blockers: ${
            blockers
              .map(blocker => `${blocker.task.id} (${blocker.impactCount})`)
              .join(', ') || 'none'
          }`,
          ...(graph.validation.valid
            ? []
            : [
                `Issues: missing=${graph.validation.missingDependencies.length}, cycles=${graph.validation.cycles.length}, duplicates=${graph.validation.duplicateTaskIds.length}`,
              ]),
        ].join('\n')
      }

      if (verb === 'plan') {
        const parsed = parsePlanArgs(rest.join(' '))
        if ('error' in parsed) return `${parsed.error}\n\n${USAGE}`
        return renderRun(supervisor.plan(parsed))
      }

      if (verb === 'list') {
        if (rest.length > 0) return USAGE
        const runs = supervisor.list()
        return runs.length > 0
          ? runs
              .map(
                run => `${run.id}  ${run.state.status}  ${run.plan.strategy}`,
              )
              .join('\n')
          : 'No supervisor runs found for the active task list.'
      }

      if (verb === 'refresh' || verb === 'cancel') {
        const id = rest[0]
        if (!id || rest.length > 1) return USAGE
        const run =
          verb === 'refresh'
            ? supervisor.refresh({ id })
            : supervisor.cancel({ id, reason: 'Cancelled with /supervisor.' })
        return renderRun(run)
      }

      return USAGE
    } catch (error) {
      return `Supervisor error: ${
        error instanceof Error ? error.message : String(error)
      }`
    }
  },
  userFacingName() {
    return 'supervisor'
  },
} satisfies Command

export { parsePlanArgs }
export default supervisor
