import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GoalService } from '@kode/goals'

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
      sessionExists: () => true,
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
          acceptanceCriteria: ['Report the observed status'],
          maxIterations: 16,
          schedule: { kind: 'interval', everyMs: 3_600_000 },
        }),
      }),
      ctx(service),
    )
    expect(created?.status).toBe(201)
    const createdBody = (await created!.json()) as {
      schedule: {
        id: string
        revision: number
        status: string
        acceptanceCriteria: string[]
        maxIterations: number
      }
    }
    expect(createdBody.schedule.status).toBe('scheduled')
    expect(createdBody.schedule.revision).toBe(1)
    expect(createdBody.schedule.acceptanceCriteria).toEqual([
      'Report the observed status',
    ])
    expect(createdBody.schedule.maxIterations).toBe(16)

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

  test('fails closed for unknown sessions and unsafe schedule input', async () => {
    const service = new GoalService()
    const base = {
      sessionId: sessionA,
      objective: 'Bound this schedule',
      schedule: { kind: 'interval', everyMs: 1_000 },
    }
    const request = (body: unknown) =>
      new Request('http://localhost/api/goal-schedules?workspace=repo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })

    const missing = await routeGoalSchedules(request(base), {
      ...ctx(service),
      sessionExists: () => false,
    })
    expect(missing?.status).toBe(404)
    expect(service.listGoals()).toHaveLength(0)

    const stringInterval = await routeGoalSchedules(
      request({ ...base, schedule: { kind: 'interval', everyMs: '1000' } }),
      ctx(service),
    )
    expect(stringInterval?.status).toBe(400)

    const tooFast = await routeGoalSchedules(
      request({ ...base, schedule: { kind: 'interval', everyMs: 999 } }),
      ctx(service),
    )
    expect(tooFast?.status).toBe(400)

    const negativeRunAt = await routeGoalSchedules(
      request({ ...base, schedule: { kind: 'once', runAt: -1 } }),
      ctx(service),
    )
    expect(negativeRunAt?.status).toBe(400)

    const oversizedObjective = await routeGoalSchedules(
      request({ ...base, objective: 'x'.repeat(4_001) }),
      ctx(service),
    )
    expect(oversizedObjective?.status).toBe(400)
    expect(service.listGoals()).toHaveLength(0)
  })

  test('enforces request limits by UTF-8 bytes before parsing JSON', async () => {
    const service = new GoalService()
    const response = await routeGoalSchedules(
      new Request('http://localhost/api/goal-schedules', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ objective: '界'.repeat(70_000) }),
      }),
      ctx(service),
    )

    expect(response?.status).toBe(413)
    expect(service.listGoals()).toHaveLength(0)
  })

  test('edits idle definitions, queues run-now, and exposes bounded event history', async () => {
    const service = new GoalService()
    const goal = service.createGoal({
      id: 'interactive-controls',
      cwd: workspace,
      sessionId: sessionA,
      objective: 'Initial objective',
      schedule: {
        kind: 'once',
        prompt: 'Initial objective',
        runAt: Date.now() + 60_000,
      },
    })

    const edited = await routeGoalSchedules(
      new Request(
        `http://localhost/api/goal-schedules/${goal.schedule.id}?workspace=repo`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: sessionA,
            expectedRevision: goal.revision,
            objective: 'Run the focused release checks',
            acceptanceCriteria: ['Tests pass', 'Build succeeds'],
            maxIterations: 12,
            schedule: { kind: 'once', runAt: Date.now() + 120_000 },
          }),
        },
      ),
      ctx(service),
    )
    expect(edited?.status).toBe(200)
    const editedBody = (await edited!.json()) as {
      schedule: {
        id: string
        revision: number
        objective: string
        acceptanceCriteria: string[]
        maxIterations: number
      }
    }
    expect(editedBody.schedule).toMatchObject({
      objective: 'Run the focused release checks',
      acceptanceCriteria: ['Tests pass', 'Build succeeds'],
      maxIterations: 12,
    })

    const runNow = await routeGoalSchedules(
      new Request(
        `http://localhost/api/goal-schedules/${goal.schedule.id}/actions?workspace=repo`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: sessionA,
            expectedRevision: editedBody.schedule.revision,
            action: 'run_now',
          }),
        },
      ),
      ctx(service),
    )
    expect(runNow?.status).toBe(200)
    expect(service.getGoal(goal.id)?.status).toBe('scheduled')
    expect(service.getGoal(goal.id)?.activeRun).toBeUndefined()

    const history = await routeGoalSchedules(
      new Request(
        `http://localhost/api/goal-schedules/${goal.schedule.id}/events?workspace=repo&sessionId=${sessionA}&limit=2`,
      ),
      ctx(service),
    )
    expect(history?.status).toBe(200)
    const historyBody = (await history!.json()) as {
      scheduleId: string
      events: Array<{ type: string; message?: string; data?: unknown }>
    }
    expect(historyBody.scheduleId).toBe(goal.schedule.id)
    expect(historyBody.events.map(event => event.type)).toEqual([
      'updated',
      'run_requested',
    ])
    expect(historyBody.events.every(event => event.data === undefined)).toBe(
      true,
    )
  })

  test('fails closed for stale edits, invalid event limits, and live-run edits', async () => {
    const service = new GoalService()
    const scheduled = service.createGoal({
      id: 'edit-conflict',
      cwd: workspace,
      sessionId: sessionA,
      objective: 'Protect concurrent edits',
      schedule: {
        kind: 'once',
        prompt: 'Protect concurrent edits',
        runAt: Date.now(),
      },
    })
    service.claimDueSchedules({ cwd: workspace, sessionId: sessionA })
    const running = service.getGoal(scheduled.id)!

    const liveEdit = await routeGoalSchedules(
      new Request(
        `http://localhost/api/goal-schedules/${scheduled.schedule.id}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: sessionA,
            expectedRevision: running.revision,
            objective: 'Unsafe rewrite',
          }),
        },
      ),
      ctx(service),
    )
    expect(liveEdit?.status).toBe(409)

    const badLimit = await routeGoalSchedules(
      new Request(
        `http://localhost/api/goal-schedules/${scheduled.schedule.id}/events?sessionId=${sessionA}&limit=101`,
      ),
      ctx(service),
    )
    expect(badLimit?.status).toBe(400)
  })
})
