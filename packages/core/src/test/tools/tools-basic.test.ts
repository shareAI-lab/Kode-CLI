import { test, expect, describe } from 'bun:test'
import { getAllTools } from '#tools'
import {
  __resetPlanModeForTests,
  enterPlanMode,
  exitPlanMode,
  getPlanConversationKey,
  getPlanFilePath,
  isPlanModeEnabled,
  setActivePlanConversationKey,
} from '#core/utils/planMode'
import { hasPermissionsToUseTool } from '#core/permissions'
import { FileWriteTool } from '#tools/tools/filesystem/FileWriteTool/FileWriteTool'
import { FileReadTool } from '#tools/tools/filesystem/FileReadTool/FileReadTool'
import { BashTool } from '#tools/tools/system/BashTool/BashTool'
import { BunShell } from '#runtime/shell'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { ToolUseContext } from '#core/tooling/Tool'
import { createAssistantMessage } from '#core/utils/messages'

const makeContext = (safeMode = true): ToolUseContext => ({
  abortController: new AbortController(),
  messageId: 'test',
  options: {
    commands: [],
    tools: [],
    verbose: false,
    slowAndCapableModel: undefined,
    safeMode,
    forkNumber: 0,
    messageLogName: 'test',
    maxThinkingTokens: 0,
  },
  readFileTimestamps: {},
})

describe('Tool registry', () => {
  test('includes core built-in tools', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'kode-config-'))
    process.env.KODE_CONFIG_DIR = configDir
    try {
      const toolNames = getAllTools().map(t => t.name)
      expect(toolNames).toContain('Bash')
      expect(toolNames).toContain('WebFetch')
      expect(toolNames).toContain('WebSearch')
      expect(toolNames).toContain('AskUserQuestion')
      expect(toolNames).toContain('EnterPlanMode')
      expect(toolNames).toContain('ExitPlanMode')
      expect(toolNames).toContain('TaskOutput')
      expect(toolNames).toContain('TaskStop')
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })
})

describe('Plan mode gating', () => {
  test('hard-denies writes while in plan mode', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'kode-config-'))
    process.env.KODE_CONFIG_DIR = configDir
    __resetPlanModeForTests()
    try {
      const ctx = makeContext()
      setActivePlanConversationKey(getPlanConversationKey(ctx))
      enterPlanMode(ctx)
      expect(isPlanModeEnabled(ctx)).toBe(true)
      const result = await hasPermissionsToUseTool(
        FileWriteTool,
        { file_path: '/tmp/a', content: 'x' },
        ctx,
        createAssistantMessage(''),
      )
      expect(result.result).toBe(false)
      if (result.result === false) {
        expect(result.shouldPromptUser).toBe(false)
      } else {
        throw new Error('Expected permission denied result')
      }
      exitPlanMode(ctx)
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('allows read tool while in plan mode', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'kode-config-'))
    process.env.KODE_CONFIG_DIR = configDir
    __resetPlanModeForTests()
    try {
      const ctx = makeContext(false)
      setActivePlanConversationKey(getPlanConversationKey(ctx))
      enterPlanMode(ctx)
      const result = await hasPermissionsToUseTool(
        FileReadTool,
        { file_path: '/tmp/a' },
        ctx,
        createAssistantMessage(''),
      )
      expect(result.result).toBe(false)
      if (result.result === false) {
        expect(result.shouldPromptUser).not.toBe(false)
      } else {
        throw new Error('Expected permission denied result')
      }
      exitPlanMode(ctx)
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('hard-denies writing the plan file while in plan mode', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'kode-config-'))
    process.env.KODE_CONFIG_DIR = configDir
    __resetPlanModeForTests()
    try {
      const ctx = makeContext()
      setActivePlanConversationKey(getPlanConversationKey(ctx))
      enterPlanMode(ctx)
      const planFilePath = getPlanFilePath(
        undefined,
        getPlanConversationKey(ctx),
      )
      const result = await hasPermissionsToUseTool(
        FileWriteTool,
        { file_path: planFilePath, content: '# Plan\n' },
        ctx,
        createAssistantMessage(''),
      )
      expect(result.result).toBe(false)
      if (result.result === false) {
        expect(result.shouldPromptUser).toBe(false)
      } else {
        throw new Error('Expected permission denied result')
      }
      exitPlanMode(ctx)
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('hard-denies writing agent plan files while in plan mode', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'kode-config-'))
    process.env.KODE_CONFIG_DIR = configDir
    __resetPlanModeForTests()
    try {
      const ctx = makeContext()
      const conversationKey = getPlanConversationKey(ctx)
      setActivePlanConversationKey(conversationKey)
      enterPlanMode(ctx)
      const agentPlanFilePath = getPlanFilePath('agent-1', conversationKey)
      const result = await hasPermissionsToUseTool(
        FileWriteTool,
        { file_path: agentPlanFilePath, content: '# Agent plan\n' },
        ctx,
        createAssistantMessage(''),
      )
      expect(result.result).toBe(false)
      if (result.result === false) {
        expect(result.shouldPromptUser).toBe(false)
      } else {
        throw new Error('Expected permission denied result')
      }
      exitPlanMode(ctx)
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })
})

describe('Bash background execution', () => {
  test('executes background command and reports output', async () => {
    const { bashId } = BunShell.getInstance().execInBackground('echo hello')
    expect(bashId).toBeTruthy()
    expect(bashId).toMatch(/^b[0-9a-f]{6}$/i)
    // Allow process to finish
    await new Promise(resolve => setTimeout(resolve, 200))
    const output = BunShell.getInstance().getBackgroundOutput(bashId)
    expect(output).not.toBeNull()
    if (output) {
      expect(output.stdout.trim()).toBe('hello')
    }
  })

  test('readBackgroundOutput returns only new output', async () => {
    const command =
      process.platform === 'win32' ? 'echo a; echo b' : 'printf "a\\nb\\n"'
    const { bashId } = BunShell.getInstance().execInBackground(command)
    expect(bashId).toBeTruthy()
    expect(bashId).toMatch(/^b[0-9a-f]{6}$/i)
    await new Promise(resolve => setTimeout(resolve, 200))

    const first = BunShell.getInstance().readBackgroundOutput(bashId)
    expect(first).not.toBeNull()
    if (first) {
      expect(first.stdout).toContain('a')
      expect(first.stdout).toContain('b')
    }

    const second = BunShell.getInstance().readBackgroundOutput(bashId)
    expect(second).not.toBeNull()
    if (second) {
      expect(second.stdout).toBe('')
      expect(second.stderr).toBe('')
    }
  })
})
