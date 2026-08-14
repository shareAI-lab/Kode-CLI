import type { Command } from '@commander-js/extra-typings'

import { GoalService } from '@kode/goals'
import { getOriginalCwd } from '#core/utils/state'

function goalStatusLabel(status: string): string {
  switch (status) {
    case 'scheduled':
      return 'scheduled'
    case 'running':
      return 'running'
    case 'awaiting_approval':
      return 'awaiting approval'
    case 'paused':
      return 'paused'
    case 'completed':
      return 'completed'
    default:
      return status
  }
}

function printGoalList(cwd: string): void {
  const service = new GoalService()
  const goals = service.listGoals()
  const scoped = goals.filter(goal => goal.cwd === cwd)
  if (scoped.length === 0) {
    console.log('No goals for the current working directory.')
    return
  }
  for (const goal of scoped) {
    const nextRun = goal.schedule.nextRunAt
      ? new Date(goal.schedule.nextRunAt).toISOString()
      : '-'
    console.log(
      `${goal.id}  ${goalStatusLabel(goal.status).padEnd(18)} created=${new Date(
        goal.createdAt,
      )
        .toISOString()
        .slice(
          0,
          19,
        )} next=${nextRun.slice(0, 19)}  ${goal.objective.slice(0, 60)}`,
    )
  }
}

export function registerGoalCommands(program: Command): void {
  const goal = program
    .command('goal')
    .description('Inspect durable goal schedules and status')

  goal
    .command('list')
    .description('List goals for the current working directory')
    .action(() => {
      printGoalList(getOriginalCwd())
      process.exit(0)
    })

  goal
    .command('status <goalId>')
    .description('Show one goal by id')
    .action((goalId: string) => {
      const service = new GoalService()
      const record = service.getGoal(goalId)
      if (!record) {
        console.log(`No goal found: ${goalId}`)
        process.exitCode = 1
        return
      }
      console.log(
        [
          `id: ${record.id}`,
          `status: ${goalStatusLabel(record.status)}`,
          `cwd: ${record.cwd}`,
          `session: ${record.sessionId}`,
          `objective: ${record.objective}`,
          `created: ${new Date(record.createdAt).toISOString()}`,
          `updated: ${new Date(record.updatedAt).toISOString()}`,
          ...(record.schedule.nextRunAt
            ? [`next: ${new Date(record.schedule.nextRunAt).toISOString()}`]
            : []),
        ].join('\n'),
      )
      process.exit(0)
    })
}
