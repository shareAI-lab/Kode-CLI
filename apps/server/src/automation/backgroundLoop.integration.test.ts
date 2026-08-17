import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GoalService } from '@kode/goals'
import {
  getCwd,
  getOriginalCwd,
  setCwd,
  setOriginalCwd,
} from '@kode/core/utils/state'

import { startKodeDaemon, type KodeDaemon } from '../server'
import { processDaemonRuntimeCoordinator } from '../turnGate'

async function waitForClaim(
  service: GoalService,
  goalId: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (service.getGoal(goalId)?.schedule.lastClaimedAt !== undefined) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('Timed out waiting for detached background loop claim.')
}

async function restoreRuntimeCwd(cwd: string, originalCwd: string) {
  await processDaemonRuntimeCoordinator.runStartupExclusive(async () => {
    setOriginalCwd(originalCwd)
    await setCwd(cwd)
  })
}

describe('detached background loop', () => {
  test('runs an opted-in loop without any connected WebSocket client', async () => {
    const previousConfigDir = process.env.KODE_CONFIG_DIR
    const runtimeCwd = getCwd()
    const runtimeOriginalCwd = getOriginalCwd()
    const configDir = mkdtempSync(join(tmpdir(), 'kode-background-config-'))
    const workspace = mkdtempSync(join(tmpdir(), 'kode-background-workspace-'))
    let daemon: KodeDaemon | null = null
    process.env.KODE_CONFIG_DIR = configDir

    try {
      daemon = await startKodeDaemon({ cwd: workspace, port: 0, echo: true })
      const service = new GoalService()
      const goal = service.createGoal({
        cwd: workspace,
        sessionId: '11111111-1111-4111-8111-111111111111',
        objective: 'Verify detached scheduling',
        schedule: {
          kind: 'interval',
          prompt: 'Verify detached scheduling',
          everyMs: 60_000,
          anchorAt: Date.now(),
        },
        metadata: { backgroundKeepAlive: true },
      })

      await waitForClaim(service, goal.id)
      expect(service.getGoal(goal.id)).toMatchObject({
        status: 'scheduled',
        schedule: { lastClaimedAt: expect.any(Number) },
      })
    } finally {
      daemon?.stop()
      await restoreRuntimeCwd(runtimeCwd, runtimeOriginalCwd)
      if (previousConfigDir === undefined) delete process.env.KODE_CONFIG_DIR
      else process.env.KODE_CONFIG_DIR = previousConfigDir
      rmSync(configDir, { recursive: true, force: true })
      rmSync(workspace, { recursive: true, force: true })
    }
  }, 20_000)
})
