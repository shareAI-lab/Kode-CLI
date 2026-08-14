import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GoalService } from '#core/goals'
import {
  getCwd,
  getOriginalCwd,
  setCwd,
  setOriginalCwd,
} from '#core/utils/state'
import {
  resetKodeAgentSessionIdForTests,
  setKodeAgentSessionId,
} from '#protocol/utils/kodeAgentSessionId'

import goal, { parseGoalStartArgs } from './goal'

describe('/goal', () => {
  const originalConfigDir = process.env.KODE_CONFIG_DIR
  const originalCwd = getCwd()
  const originalOriginalCwd = getOriginalCwd()
  let rootDir: string
  let workspace: string

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'kode-goal-command-root-'))
    workspace = mkdtempSync(join(tmpdir(), 'kode-goal-command-workspace-'))
    process.env.KODE_CONFIG_DIR = rootDir
    await setCwd(workspace)
    setOriginalCwd(workspace)
    setKodeAgentSessionId('goal-command-session')
  })

  afterEach(async () => {
    await setCwd(originalCwd)
    setOriginalCwd(originalOriginalCwd)
    resetKodeAgentSessionIdForTests()
    if (originalConfigDir === undefined) delete process.env.KODE_CONFIG_DIR
    else process.env.KODE_CONFIG_DIR = originalConfigDir
    rmSync(rootDir, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  })

  test('starts an immediately active session goal and reports status', async () => {
    const started = await goal.call(
      'Ship the focused goal integration --accept "Focused tests pass" --accept Typecheck passes --max-iterations=12',
    )
    expect(started).toContain('Goal started and is active for this session')

    const active = new GoalService().findActiveGoal({
      cwd: workspace,
      sessionId: 'goal-command-session',
    })
    expect(active?.status).toBe('running')
    expect(active?.objective).toBe('Ship the focused goal integration')
    expect(active?.acceptanceCriteria).toEqual([
      'Focused tests pass',
      'Typecheck passes',
    ])
    expect(active?.loop.maxIterations).toBe(12)

    const status = await goal.call('status')
    expect(status).toContain(`Goal ${active?.id}`)
    expect(status).toContain('Status: running')
    expect(status).toContain('Acceptance: Focused tests pass; Typecheck passes')
    expect(status).toContain('Continuation limit: 12')

    const list = await goal.call('list')
    expect(list).toContain(active?.id ?? '')
    expect(list).toContain('Ship the focused goal integration')
  })

  test('limits stats to the requested session goal', async () => {
    const service = new GoalService()
    const first = service.createGoal({
      id: 'stats-first-goal',
      cwd: workspace,
      sessionId: 'goal-command-session',
      objective: 'Count only this goal',
      schedule: {
        kind: 'once',
        prompt: 'Count only this goal',
        runAt: Date.now() + 60_000,
      },
    })
    service.createGoal({
      id: 'stats-second-goal',
      cwd: workspace,
      sessionId: 'goal-command-session',
      objective: 'Do not include this goal',
      schedule: {
        kind: 'once',
        prompt: 'Do not include this goal',
        runAt: Date.now() + 60_000,
      },
    })

    expect(await goal.call(`stats ${first.id}`)).toContain('Total: 1')
    expect(await goal.call('stats missing-goal')).toBe(
      'Goal not found for this session: missing-goal',
    )
  })

  test('pauses and resumes a running goal through explicit controls', async () => {
    await goal.call('start Pause this active goal')
    const service = new GoalService()
    const active = service.findActiveGoal({
      cwd: workspace,
      sessionId: 'goal-command-session',
    })

    const paused = await goal.call(`pause ${active?.id}`)
    expect(paused).toContain('Status: paused')
    expect(service.getGoal(active?.id ?? '')?.activeRun).toBeUndefined()

    const resumed = await goal.call(`resume ${active?.id}`)
    expect(resumed).toContain('Status: running')
    expect(service.getGoal(active?.id ?? '')?.activeRun).toBeDefined()
  })

  test('cancels a running goal and resumes a paused one', async () => {
    await goal.call('start Cancel this goal')
    const service = new GoalService()
    const active = service.findActiveGoal({
      cwd: workspace,
      sessionId: 'goal-command-session',
    })
    expect(active).not.toBeNull()

    const cancelled = await goal.call(`cancel ${active?.id}`)
    expect(cancelled).toContain('Status: cancelled')

    const paused = service.createGoal({
      id: 'paused-goal',
      cwd: workspace,
      sessionId: 'goal-command-session',
      objective: 'Resume this goal',
      schedule: {
        kind: 'once',
        prompt: 'Resume this goal.',
        runAt: Date.now() + 60_000,
      },
    })
    service.pauseGoal(paused.id, { reason: 'Waiting for user.' })

    const resumed = await goal.call(`resume ${paused.id}`)
    expect(resumed).toContain('Status: scheduled')
    expect(resumed).toContain('Resume this goal')
  })

  test('refuses a second active goal in the same session', async () => {
    await goal.call('start First active goal')
    const second = await goal.call('start Second active goal')

    expect(second).toContain('An active goal already exists for this session')
    expect(
      new GoalService()
        .listGoals()
        .filter(
          item =>
            item.sessionId === 'goal-command-session' &&
            item.status === 'running',
        ),
    ).toHaveLength(1)
  })

  test('returns concise usage for missing or malformed control arguments', async () => {
    expect(await goal.call('')).toContain('Usage: /goal')
    expect(await goal.call('cancel')).toContain('goal ID is required')
    expect(await goal.call('status unknown-goal')).toBe(
      'No goal found for this session.',
    )
    expect(await goal.call('Ship it --max-iterations nope')).toContain(
      '--max-iterations must be an integer between 1 and 64',
    )
    expect(
      await goal.call('Ship it --max-iterations 2 --max-iterations 3'),
    ).toContain('Use only one --max-iterations option')
    expect(await goal.call('Ship it --accept')).toContain(
      'Each --accept option needs a criterion',
    )
    expect(new GoalService().listGoals()).toHaveLength(0)
  })

  test('parses ordered acceptance and continuation options without leaking them into the objective', () => {
    expect(
      parseGoalStartArgs(
        'Deliver the release --accept "Tests pass" --max-iterations 4 --accept Build succeeds',
      ),
    ).toEqual({
      objective: 'Deliver the release',
      acceptanceCriteria: ['Tests pass', 'Build succeeds'],
      maxIterations: 4,
    })
  })

  test('edits idle goals with revision safety and shows bounded event history', async () => {
    const service = new GoalService()
    const created = service.createGoal({
      id: 'editable-goal',
      cwd: workspace,
      sessionId: 'goal-command-session',
      objective: 'Initial objective',
      acceptanceCriteria: ['Preserve this when not replaced'],
      schedule: {
        kind: 'once',
        prompt: 'Initial objective',
        runAt: Date.now() + 60_000,
      },
    })

    const edited = await goal.call(
      `edit ${created.id} Ship the complete workflow --accept "Tests pass" --accept "Build succeeds" --max-iterations 10`,
    )
    expect(edited).toContain('Objective: Ship the complete workflow')
    expect(edited).toContain('Acceptance: Tests pass; Build succeeds')
    expect(edited).toContain('Continuation limit: 10')
    expect(service.getGoal(created.id)?.schedule.prompt).toBe(
      'Ship the complete workflow',
    )

    const history = await goal.call(`history ${created.id} 2`)
    expect(history).toContain('history (latest 2)')
    expect(history).toContain('updated')
    expect(history).toContain(
      'Updated objective, acceptanceCriteria, maxIterations',
    )
  })

  test('runs due work through the scheduler and retries failed goals explicitly', async () => {
    const service = new GoalService()
    const scheduled = service.createGoal({
      id: 'manual-run-goal',
      cwd: workspace,
      sessionId: 'goal-command-session',
      objective: 'Run this future goal now',
      schedule: {
        kind: 'once',
        prompt: 'Run this future goal now',
        runAt: Date.now() + 60_000,
      },
    })

    const running = await goal.call(`run ${scheduled.id}`)
    expect(running).toContain('Status: running')
    const active = service.getGoal(scheduled.id)!
    service.failGoal(active.id, {
      runId: active.activeRun?.id,
      reason: 'Focused test failed.',
    })

    expect(await goal.call(`resume ${scheduled.id}`)).toContain(
      'Resume is available only for paused goals',
    )
    const retried = await goal.call(`retry ${scheduled.id}`)
    expect(retried).toContain('Status: running')
    expect(await goal.call(`history ${scheduled.id} 0`)).toBe(
      'History limit must be an integer between 1 and 100.',
    )
  })
})
