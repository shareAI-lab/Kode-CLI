import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GoalService, GoalStorage } from '#core/goals'
import { formatGoalStats } from './goal'

test('formatGoalStats end-to-end with real store', async () => {
  const root = mkdtempSync(join(tmpdir(), 'kode-stats-e2e-'))
  try {
    const storage = new GoalStorage({ rootDir: root })
    const service = new GoalService({ rootDir: root })
    service.createGoal({
      cwd: '/tmp/x',
      sessionId: 's1',
      objective: 'g1',
      schedule: { kind: 'once', prompt: 'p', runAt: 0 },
      loop: { maxIterations: 5, continuationPrompt: 'c' },
    })
    const goalId = storage.listGoals()[0]!.id
    const claimed = service.claimDueSchedules({
      cwd: '/tmp/x',
      sessionId: 's1',
      now: 1,
    })
    service.recordContinuation(goalId, {
      runId: claimed[0]!.runId,
      reason: 'continue',
      now: 2,
    })
    storage.mutateGoal(goalId, current => ({
      goal: {
        ...current,
        status: 'completed',
        completedAt: 3_000,
        activeRun: undefined,
        lease: undefined,
      },
      result: true,
    }))

    const stats = formatGoalStats(
      [storage.getGoal(goalId)!],
      id =>
        storage
          .listEvents(id, { limit: 100 })
          .filter(event => event.type === 'continued').length,
    )
    expect(stats).toContain('Total: 1')
    expect(stats).toContain('completed 1')
    expect(stats).toContain('Avg continuations: 1.0')
    expect(stats).toContain('Completion rate: 100%')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
