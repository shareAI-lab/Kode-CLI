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

import loop, { parseEveryInterval, parseLoopCreateArgs } from './loop'

describe('/loop', () => {
  const originalConfigDir = process.env.KODE_CONFIG_DIR
  const originalCwd = getCwd()
  const originalOriginalCwd = getOriginalCwd()
  let rootDir: string
  let workspace: string

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'kode-loop-command-root-'))
    workspace = mkdtempSync(join(tmpdir(), 'kode-loop-command-workspace-'))
    process.env.KODE_CONFIG_DIR = rootDir
    await setCwd(workspace)
    setOriginalCwd(workspace)
    setKodeAgentSessionId('loop-command-session')
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

  test('parses only supported explicit fixed intervals', () => {
    expect(parseEveryInterval('30s')).toBe(30_000)
    expect(parseEveryInterval('5m')).toBe(300_000)
    expect(parseEveryInterval('1h')).toBe(3_600_000)
    expect(parseEveryInterval('0s')).toBeNull()
    expect(parseEveryInterval('5d')).toBeNull()

    expect(parseLoopCreateArgs('Check CI --every 5m')).toEqual({
      objective: 'Check CI',
      everyMs: 300_000,
      backgroundKeepAlive: false,
    })
    expect(parseLoopCreateArgs('Check CI --background --every 5m')).toEqual({
      objective: 'Check CI',
      everyMs: 300_000,
      backgroundKeepAlive: true,
    })
    expect(parseLoopCreateArgs('Check CI --keep-alive --every 5m')).toEqual({
      objective: 'Check CI',
      everyMs: 300_000,
      backgroundKeepAlive: true,
    })
    expect(parseLoopCreateArgs('Check CI')).toEqual({
      error: 'Missing --every interval (for example: --every 5m).',
    })
  })

  test('creates, inspects, and cancels an interval goal without running a model', async () => {
    const created = await loop.call('Check CI status --every 30s')
    expect(created).toContain('Loop created:')
    expect(created).toContain('Every: 30000ms')

    const loops = new GoalService()
      .listGoals()
      .filter(goal => goal.sessionId === 'loop-command-session')
    expect(loops).toHaveLength(1)
    const goal = loops[0]!
    expect(goal.status).toBe('scheduled')
    expect(goal.schedule.kind).toBe('interval')
    expect(goal.schedule.prompt).toBe('Check CI status')
    expect(goal.metadata?.backgroundKeepAlive).toBeUndefined()

    const status = await loop.call(`status ${goal.id}`)
    expect(status).toContain('Status: scheduled')
    expect(status).toContain('every 30000ms')

    const cancelled = await loop.call(`cancel ${goal.id}`)
    expect(cancelled).toContain('Status: cancelled')
  })

  test('rejects missing interval and non-loop cancellation targets', async () => {
    expect(await loop.call('Run something')).toContain(
      'Missing --every interval',
    )

    const once = new GoalService().createGoal({
      id: 'one-off',
      cwd: workspace,
      sessionId: 'loop-command-session',
      objective: 'A one-off goal',
      schedule: { kind: 'once', prompt: 'Do one-off work.', runAt: Date.now() },
    })
    expect(await loop.call(`cancel ${once.id}`)).toBe(
      `Interval loop not found for this session: ${once.id}`,
    )
  })

  test('does not disclose another session loop by ID', async () => {
    const foreign = new GoalService().createGoal({
      id: 'foreign-loop',
      cwd: workspace,
      sessionId: 'other-session',
      objective: 'Private loop objective',
      schedule: {
        kind: 'interval',
        prompt: 'Private loop prompt',
        everyMs: 30_000,
        anchorAt: Date.now(),
      },
    })

    expect(await loop.call(`status ${foreign.id}`)).toBe(
      'No interval loop found for this session.',
    )
  })
})
