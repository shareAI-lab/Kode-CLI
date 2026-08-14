import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GoalService } from '@kode/goals'

import { BackgroundLoopSessions } from './backgroundLoopSessions'
import { SessionRegistry } from '../sessionRegistry'

describe('BackgroundLoopSessions', () => {
  test('rehydrates an explicitly opted-in loop without a pre-existing transcript', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'kode-background-loop-root-'))
    const workspace = mkdtempSync(
      join(tmpdir(), 'kode-background-loop-workspace-'),
    )
    try {
      const service = new GoalService({ rootDir })
      service.createGoal({
        cwd: workspace,
        sessionId: '11111111-1111-4111-8111-111111111111',
        objective: 'Check CI',
        schedule: {
          kind: 'interval',
          prompt: 'Check CI',
          everyMs: 60_000,
          anchorAt: 1_000,
        },
        metadata: { backgroundKeepAlive: true },
      })
      service.createGoal({
        cwd: workspace,
        sessionId: '22222222-2222-4222-8222-222222222222',
        objective: 'Do not wake',
        schedule: {
          kind: 'interval',
          prompt: 'Do not wake',
          everyMs: 60_000,
          anchorAt: 1_000,
        },
      })

      const sessions = new BackgroundLoopSessions({
        service,
        sessionRegistry: new SessionRegistry(),
      })
      const restored = sessions.list()

      expect(restored).toHaveLength(1)
      expect(restored[0]).toMatchObject({
        cwd: workspace,
        sessionId: '11111111-1111-4111-8111-111111111111',
        messages: [],
      })
      expect(sessions.has(restored[0]!)).toBe(true)
    } finally {
      rmSync(rootDir, { recursive: true, force: true })
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  test('does not revive paused or cancelled background loops', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'kode-background-loop-state-'))
    const workspace = mkdtempSync(
      join(tmpdir(), 'kode-background-loop-state-workspace-'),
    )
    try {
      const service = new GoalService({ rootDir })
      const paused = service.createGoal({
        cwd: workspace,
        sessionId: 'paused-session',
        objective: 'Pause',
        schedule: {
          kind: 'interval',
          prompt: 'Pause',
          everyMs: 60_000,
          anchorAt: 1_000,
        },
        metadata: { backgroundKeepAlive: true },
      })
      const cancelled = service.createGoal({
        cwd: workspace,
        sessionId: 'cancelled-session',
        objective: 'Cancel',
        schedule: {
          kind: 'interval',
          prompt: 'Cancel',
          everyMs: 60_000,
          anchorAt: 1_000,
        },
        metadata: { backgroundKeepAlive: true },
      })
      service.pauseGoal(paused.id, { reason: 'Paused for test.' })
      service.cancelGoal(cancelled.id, { reason: 'Cancelled for test.' })

      expect(
        new BackgroundLoopSessions({
          service,
          sessionRegistry: new SessionRegistry(),
        }).list(),
      ).toEqual([])
    } finally {
      rmSync(rootDir, { recursive: true, force: true })
      rmSync(workspace, { recursive: true, force: true })
    }
  })
})
