import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  getCwd,
  getOriginalCwd,
  setCwd,
  setOriginalCwd,
} from '#core/utils/state'
import {
  __resetPlanModeForTests,
  getPlanConversationKey,
  getPlanFilePath,
} from '#core/utils/planMode'
import type { ToolUseContext } from '#core/tooling/Tool'

const makeContext = (): ToolUseContext => ({
  abortController: new AbortController(),
  messageId: 'test',
  options: {
    commands: [],
    tools: [],
    verbose: false,
    safeMode: false,
    forkNumber: 0,
    messageLogName: 'plan-directory',
    maxThinkingTokens: 0,
  },
  readFileTimestamps: {},
})

describe('plan files directory setting', () => {
  let configDir: string
  let projectDir: string
  let runnerCwd: string
  let runnerOriginalCwd: string

  beforeEach(async () => {
    runnerCwd = getCwd()
    runnerOriginalCwd = getOriginalCwd()
    configDir = mkdtempSync(join(tmpdir(), 'kode-config-'))
    projectDir = mkdtempSync(join(tmpdir(), 'kode-project-'))
    process.env.KODE_CONFIG_DIR = configDir
    await setCwd(projectDir)
    setOriginalCwd(projectDir)
    __resetPlanModeForTests()
  })

  afterEach(async () => {
    await setCwd(runnerCwd)
    setOriginalCwd(runnerOriginalCwd)
    delete process.env.KODE_CONFIG_DIR
    rmSync(configDir, { recursive: true, force: true })
    rmSync(projectDir, { recursive: true, force: true })
  })

  test('respects plansDirectory from project settings', () => {
    mkdirSync(join(projectDir, '.kode'), { recursive: true })
    writeFileSync(
      join(projectDir, '.kode', 'settings.json'),
      JSON.stringify({ plansDirectory: '.plans' }, null, 2) + '\n',
      'utf-8',
    )

    const ctx = makeContext()
    const conversationKey = getPlanConversationKey(ctx)
    const planFilePath = getPlanFilePath(undefined, conversationKey)

    expect(planFilePath.startsWith(join(projectDir, '.plans'))).toBe(true)
    expect(existsSync(join(projectDir, '.plans'))).toBe(true)
  })
})
