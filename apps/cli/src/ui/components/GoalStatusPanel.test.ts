import { describe, expect, test } from 'bun:test'
import { buildGoalStatusLineForTests } from './GoalStatusPanel'
import type { Goal } from '#core/goals'

const BASE_GOAL: Goal = {
  schemaVersion: 1,
  id: 'goal-1',
  cwd: '/tmp/x',
  sessionId: 'session-1',
  objective: '实现一个非常长的目标描述用于测试截断行为是否正常工作',
  status: 'scheduled',
  schedule: {
    id: 'schedule-1',
    goalId: 'goal-1',
    cwd: '/tmp/x',
    sessionId: 'session-1',
    kind: 'interval',
    everyMs: 60_000,
    anchorAt: 0,
    nextRunAt: 1_000_000,
    prompt: 'run',
  },
  loop: { maxIterations: 5, continuationPrompt: 'continue' },
  activeRun: undefined,
  acceptanceCriteria: [],
  createdAt: 0,
  updatedAt: 0,
  revision: 1,
}

describe('buildGoalStatusLineForTests', () => {
  test('shows progress and countdown for interval goal', () => {
    const goal: Goal = {
      ...BASE_GOAL,
      activeRun: {
        id: 'r1',
        scheduleId: 'schedule-1',
        scheduledFor: 0,
        startedAt: 0,
        turnCount: 2,
      },
    }
    const out = buildGoalStatusLineForTests({
      goal,
      now: 999_000,
      maxWidth: 80,
    })
    expect(out).not.toBeNull()
    expect(out!.label).toBe('scheduled')
    expect(out!.line).toContain('轮 2/5')
    expect(out!.line).toContain('下轮 1s')
    expect(out!.line).toContain('实现一个非常长')
  })

  test('truncates objective to fit maxWidth', () => {
    const out = buildGoalStatusLineForTests({
      goal: BASE_GOAL,
      now: 0,
      maxWidth: 30,
    })
    expect(out).not.toBeNull()
    expect(out!.line.length).toBeLessThanOrEqual(30)
    expect(out!.line).toContain('…')
  })

  test('running status', () => {
    const goal: Goal = { ...BASE_GOAL, status: 'running' }
    const out = buildGoalStatusLineForTests({ goal, now: 0, maxWidth: 80 })
    expect(out!.label).toBe('running')
    expect(out!.line).toContain('running')
  })

  test('paused/completed/failed goals render no line', () => {
    for (const status of ['paused', 'completed', 'failed'] as const) {
      const out = buildGoalStatusLineForTests({
        goal: { ...BASE_GOAL, status },
        now: 0,
        maxWidth: 80,
      })
      expect(out).toBeNull()
    }
  })
})
