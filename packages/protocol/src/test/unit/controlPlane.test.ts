import { describe, expect, test } from 'bun:test'

import {
  DaemonAgentCreateRequestSchema,
  DaemonAgentDeleteResponseSchema,
  DaemonAgentDetailResponseSchema,
  DaemonAgentUpdateRequestSchema,
  DaemonGoalScheduleListResponseSchema,
  DaemonGoalScheduleEventsResponseSchema,
  DaemonGoalScheduleMutationResponseSchema,
  DaemonGoalScheduleSummarySchema,
} from '../../controlPlane'

const agent = {
  agentType: 'review-agent',
  whenToUse: 'Review a change for correctness and regressions.',
  systemPrompt: 'Review the requested change and report findings.',
  tools: ['Read', 'Grep'],
  model: 'inherit',
  permissionMode: 'plan',
  forkContext: true,
  maxExecutionTimeMs: 300_000,
}

describe('daemon Agent control-plane schemas', () => {
  test('accepts only the runtime-backed mutable Agent fields', () => {
    expect(
      DaemonAgentCreateRequestSchema.safeParse({
        source: 'projectSettings',
        agent,
      }).success,
    ).toBe(true)

    expect(
      DaemonAgentCreateRequestSchema.safeParse({
        source: 'projectSettings',
        agent: { ...agent, skills: ['not-runtime-backed'] },
      }).success,
    ).toBe(false)
    expect(
      DaemonAgentCreateRequestSchema.safeParse({
        source: 'projectSettings',
        agent: { ...agent, maxExecutionTimeMs: 999 },
      }).success,
    ).toBe(false)
    expect(
      DaemonAgentCreateRequestSchema.safeParse({
        source: 'built-in',
        agent,
      }).success,
    ).toBe(false)
  })

  test('requires a revision for full-definition updates', () => {
    const revision = 'a'.repeat(64)
    expect(
      DaemonAgentUpdateRequestSchema.safeParse({
        source: 'userSettings',
        expectedRevision: revision,
        agent,
      }).success,
    ).toBe(true)
    expect(
      DaemonAgentUpdateRequestSchema.safeParse({
        source: 'userSettings',
        expectedRevision: 'stale',
        agent,
      }).success,
    ).toBe(false)
  })

  test('does not allow storage paths or loader metadata in responses', () => {
    const revision = 'b'.repeat(64)
    expect(
      DaemonAgentDetailResponseSchema.safeParse({
        agent: {
          ...agent,
          source: 'projectSettings',
          revision,
          baseDir: 'C:/private/path',
        },
      }).success,
    ).toBe(false)
  })

  test('requires an exact delete response', () => {
    expect(
      DaemonAgentDeleteResponseSchema.safeParse({ deleted: true }).success,
    ).toBe(true)
    expect(
      DaemonAgentDeleteResponseSchema.safeParse({
        deleted: true,
        leaked: 'unexpected',
      }).success,
    ).toBe(false)
  })
})

describe('daemon goal schedule control-plane schemas', () => {
  const schedule = {
    id: 'schedule-goal-1',
    goalId: 'goal-1',
    kind: 'interval' as const,
    status: 'scheduled',
    revision: 1,
    nextRunAt: 1_000,
    createdAt: 1,
    updatedAt: 2,
    objective: 'Watch CI',
    acceptanceCriteria: ['Report CI status'],
    everyMs: 60_000,
    anchorAt: 1_000,
  }

  test('accepts list and mutation envelopes without private paths', () => {
    expect(DaemonGoalScheduleSummarySchema.safeParse(schedule).success).toBe(
      true,
    )
    expect(
      DaemonGoalScheduleListResponseSchema.safeParse({
        schedules: [schedule],
      }).success,
    ).toBe(true)
    expect(
      DaemonGoalScheduleMutationResponseSchema.safeParse({
        ok: true,
        schedule,
      }).success,
    ).toBe(true)
    expect(
      DaemonGoalScheduleSummarySchema.parse({
        ...schedule,
        acceptanceCriteria: undefined,
      }).acceptanceCriteria,
    ).toEqual([])
    expect(DaemonGoalScheduleSummarySchema.parse(schedule)).toMatchObject({
      maxIterations: 8,
      turnCount: null,
      pausedReason: null,
      lastError: null,
      lastClaimedAt: null,
      retryAt: null,
    })
    expect(
      DaemonGoalScheduleEventsResponseSchema.safeParse({
        scheduleId: schedule.id,
        events: [
          {
            id: 'event-1',
            goalId: schedule.goalId,
            type: 'updated',
            at: 2,
            revision: 2,
            from: 'paused',
            to: 'paused',
            message: 'Updated objective.',
          },
        ],
      }).success,
    ).toBe(true)
  })

  test('rejects unknown fields and invalid kinds', () => {
    expect(
      DaemonGoalScheduleSummarySchema.safeParse({
        ...schedule,
        storagePath: '/private/goals',
      }).success,
    ).toBe(false)
    expect(
      DaemonGoalScheduleSummarySchema.safeParse({
        ...schedule,
        kind: 'cron',
      }).success,
    ).toBe(false)
    expect(
      DaemonGoalScheduleMutationResponseSchema.safeParse({
        ok: false,
        schedule,
      }).success,
    ).toBe(false)
    expect(
      DaemonGoalScheduleSummarySchema.safeParse({
        ...schedule,
        status: 'unknown',
      }).success,
    ).toBe(false)
    expect(
      DaemonGoalScheduleEventsResponseSchema.safeParse({
        scheduleId: schedule.id,
        events: [
          {
            id: 'event-1',
            goalId: schedule.goalId,
            type: 'invented',
            at: 2,
            revision: 2,
          },
        ],
      }).success,
    ).toBe(false)
  })
})
