import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { EnterPlanModeTool } from '#tools/tools/interaction/PlanModeTool/EnterPlanModeTool'
import {
  __resetPlanModeForTests,
  isPlanModeEnabled,
} from '#core/utils/planMode'
import {
  __resetPermissionModeStateForTests,
  getPermissionMode,
} from '#core/utils/permissionModeState'
import type { ToolUseContext } from '#core/tooling/Tool'
import { __resetToolPermissionContextStateForTests } from '#core/utils/toolPermissionContextState'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const makeContext = (
  overrides: Partial<ToolUseContext> = {},
): ToolUseContext => ({
  abortController: new AbortController(),
  messageId: 'test',
  readFileTimestamps: {},
  options: {
    messageLogName: 'test',
    forkNumber: 0,
  },
  ...overrides,
})

describe('EnterPlanModeTool', () => {
  let configDir: string
  let previousConfigDir: string | undefined

  beforeEach(() => {
    previousConfigDir = process.env.KODE_CONFIG_DIR
    configDir = mkdtempSync(join(tmpdir(), 'kode-enter-plan-config-'))
    process.env.KODE_CONFIG_DIR = configDir
    __resetPlanModeForTests()
    __resetPermissionModeStateForTests()
    __resetToolPermissionContextStateForTests()
  })

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.KODE_CONFIG_DIR
    } else {
      process.env.KODE_CONFIG_DIR = previousConfigDir
    }
    rmSync(configDir, { recursive: true, force: true })
  })

  test('rejects agent contexts', async () => {
    const ctx = makeContext({ agentId: 'agent-1' })
    const gen = EnterPlanModeTool.call({}, ctx)
    await expect(gen.next()).rejects.toThrow(
      'EnterPlanMode tool cannot be used in agent contexts',
    )
  })

  test('enables plan mode and sets permission mode to plan', async () => {
    const ctx = makeContext()

    expect(isPlanModeEnabled(ctx)).toBe(false)
    expect(getPermissionMode(ctx)).toBe('yolo')

    expect(EnterPlanModeTool.needsPermissions()).toBe(false)
    expect(EnterPlanModeTool.requiresUserInteraction?.()).toBe(false)

    const gen = EnterPlanModeTool.call({}, ctx)
    const first = await gen.next()

    expect(first.done).toBe(false)
    if (first.done || !first.value) {
      throw new Error('Expected EnterPlanModeTool to yield a result')
    }
    expect(first.value.type).toBe('result')

    expect(isPlanModeEnabled(ctx)).toBe(true)
    expect(getPermissionMode(ctx)).toBe('plan')
    expect(ctx.options?.toolPermissionContext?.mode).toBe('plan')
  })
})
