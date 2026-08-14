import { describe, expect, test } from 'bun:test'
import { formatGoalStats } from './goal'
import type { Goal } from '#core/goals'

const BASE: Goal = {
  schemaVersion: 1,
  id: 'g1',
  cwd: '/tmp/x',
  sessionId: 's1',
  objective: 'test',
  status: 'completed',
  schedule: {
    id: 'sc1',
    goalId: 'g1',
    cwd: '/tmp/x',
    sessionId: 's1',
    kind: 'once',
    prompt: 'p',
    runAt: 0,
    nextRunAt: null,
  },
  loop: { maxIterations: 4, continuationPrompt: 'c' },
  acceptanceCriteria: [],
  createdAt: 1_000,
  updatedAt: 1_000,
  revision: 1,
  completedAt: 262_000,
}

describe('formatGoalStats', () => {
  test('empty store', () => {
    expect(formatGoalStats([])).toContain('No goals')
  })

  test('aggregates statuses, completion rate, durations', () => {
    const stats = formatGoalStats([
      BASE,
      { ...BASE, id: 'g2', status: 'completed', completedAt: 122_000 },
      { ...BASE, id: 'g3', status: 'failed' },
    ])
    expect(stats).toContain('Total: 3')
    expect(stats).toContain('completed 2')
    expect(stats).toContain('failed 1')
    expect(stats).toContain('Completion rate: 67%')
    expect(stats).toContain('Avg completion time:')
  })

  test('average continuation count', () => {
    const stats = formatGoalStats([
      { ...BASE, loop: { maxIterations: 4, continuationPrompt: 'c' } },
      {
        ...BASE,
        id: 'g2',
        loop: { maxIterations: 6, continuationPrompt: 'c' },
      },
    ])
    expect(stats).toContain('Avg continuations: 5.0')
  })
})
