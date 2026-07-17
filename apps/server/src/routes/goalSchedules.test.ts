import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GoalService } from '@kode/core/goals'

import { routeGoalSchedules } from './goalSchedules'

describe('routeGoalSchedules', () => {
  const originalConfigDir = process.env.KODE_CONFIG_DIR
  let rootDir: string
  let workspace: string
  const sessionA = '11111111-1111-4111-8111-111111111111'
  const sessionB = '22222222-2222-4222-8222-222222222222'

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'kode-goal-schedules-root-'))
    workspace = mkdtempSync(join(tmpdir(), 'kode-goal-schedules-workspace-'))
    process.env.KODE_CONFIG_DIR = rootDir
  })

  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.KODE_CONFIG_DIR
    else process.env.KODE_CONFIG_DIR = originalConfigDir
    rmSync(rootDir, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  })

  function ctx(service: GoalService) {
    return {
      cwd: workspace,
      goalService: service,
      listWorkspaces: async () => ({
        workspaces: [{ id: 'repo', path: workspace }],
        currentId: 'repo',
      }),
    }
  }

  test('lists schedules for the resolved workspace and session only', async () => {
    const service = new GoalService()
    service.createGoal({
      id: 'local-loop',
      cwd: workspace,
      sessionId: sessionA,
      objective: 'Watch CI',
      schedule: {
        kind: 'interval',
        prompt: 'Watch CI',
        everyMs: 60_000,
        anchorAt: Date.now() + 60_000,
      },
    })
    service.createGoal({
      id: 'other-session',
      cwd: workspace,
      sessionId: sessionB,
      objective: 'Private',
      schedule: {
        kind: 'once',
        prompt: 'Private',
        runAt: Date.now(),
      },
    })

    const response = await routeGoalSchedules(
      new Request(
        `http://localhost/api/goal-schedules?workspace=repo&sessionId=${sessionA}`,
      ),
      ctx(service),
    )
    expect(response?.status).toBe(200)
    const body = (await response!.json()) as {
      schedules: Array<{ goalId: string; kind: string; objective: string }>
    }
    expect(body.schedules).toHaveLength(1)
    expect(body.schedules[0]).toMatchObject({
      goalId: 'local-loop',
      kind: 'interval',
      objective: 'Watch CI',
    })
  })

  test('creates, pauses, resumes, and cancels through control-plane actions', async () => {
    const service = new GoalService()

    const created = await routeGoalSchedules(
      new Request('http://localhost/api/goal-schedules?workspace=repo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: sessionA,
          objective: 'Nightly health check',
          schedule: { kind: 'interval', everyMs: 3_600_000 },
        }),
      }),
      ctx(service),
    )
    expect(created?.status).toBe(201)
    const createdBody = (await created!.json()) as {
      schedule: { id: string; revision: number; status: string }
    }
    expect(createdBody.schedule.status).toBe('scheduled')
    expect(createdBody.schedule.revision).toBe(1)

    const scheduleId = createdBody.schedule.id
    const paused = await routeGoalSchedules(
      new Request(
        `http://localhost/api/goal-schedules/${scheduleId}/actions?workspace=repo`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: sessionA,
            expectedRevision: 1,
            action: 'pause',
            reason: 'Hold overnight',
          }),
        },
      ),
      ctx(service),
    )
    expect(paused?.status).toBe(200)
    const pausedBody = (await paused!.json()) as {
      schedule: { status: string; revision: number }
    }
    expect(pausedBody.schedule).toMatchObject({
      status: 'paused',
      revision: 2,
    })

    const resumed = await routeGoalSchedules(
      new Request(
        `http://localhost/api/goal-schedules/${scheduleId}/actions?workspace=repo`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: sessionA,
            expectedRevision: 2,
            action: 'resume',
          }),
        },
      ),
      ctx(service),
    )
    expect(resumed?.status).toBe(200)
    const resumedBody = (await resumed!.json()) as {
      schedule: { status: string; revision: number }
    }
    expect(resumedBody.schedule.status).toBe('scheduled')

    const cancelled = await routeGoalSchedules(
      new Request(
        `http://localhost/api/goal-schedules/${scheduleId}/actions?workspace=repo`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: sessionA,
            expectedRevision: resumedBody.schedule.revision,
            action: 'cancel',
          }),
        },
      ),
      ctx(service),
    )
    expect(cancelled?.status).toBe(200)
    const cancelledBody = (await cancelled!.json()) as {
      schedule: { status: string }
    }
    expect(cancelledBody.schedule.status).toBe('cancelled')
  })

  test('rejects invalid session ids and stale revisions', async () => {
    const service = new GoalService()
    const goal = service.createGoal({
      id: 'rev-check',
      cwd: workspace,
      sessionId: sessionA,
      objective: 'Rev check',
      schedule: {
        kind: 'once',
        prompt: 'Rev check',
        runAt: Date.now() + 60_000,
      },
    })

    const badSession = await routeGoalSchedules(
      new Request('http://localhost/api/goal-schedules?sessionId=not-a-uuid'),
      ctx(service),
    )
    expect(badSession?.status).toBe(400)

    const stale = await routeGoalSchedules(
      new Request(
        `http://localhost/api/goal-schedules/${goal.schedule.id}/actions`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: sessionA,
            expectedRevision: 99,
            action: 'pause',
          }),
        },
      ),
      ctx(service),
    )
    expect(stale?.status).toBe(409)

    const otherPath = await routeGoalSchedules(
      new Request('http://localhost/api/tasks'),
      ctx(service),
    )
    expect(otherPath).toBeUndefined()
  })
})
