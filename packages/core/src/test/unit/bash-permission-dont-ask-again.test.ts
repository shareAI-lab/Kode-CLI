import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createDefaultToolPermissionContext } from '#core/types/toolPermissionContext'
import { hasPermissionsToUseTool, savePermission } from '#core/permissions'
import { BashTool } from '#tools/tools/system/BashTool/BashTool'
import { checkBashPermissions } from '@kode/permissions/bash'
import {
  __resetToolPermissionContextStateForTests,
  setToolPermissionContextForConversationKey,
} from '#core/utils/toolPermissionContextState'
import { BunShell } from '#runtime/shell'
import { getCwd, setCwd } from '#core/utils/state'
import { loadToolPermissionContextFromDisk } from '#core/utils/permissions/toolPermissionSettings'
import {
  getCurrentProjectConfig,
  saveCurrentProjectConfig,
} from '#core/utils/config'
import type { ToolUseContext } from '#core/tooling/Tool'
import type { ToolPermissionContext } from '#core/types/toolPermissionContext'
import { createAssistantMessage } from '#core/utils/messages'

function makeToolUseContext(
  toolPermissionContext: ToolPermissionContext,
): ToolUseContext {
  return {
    abortController: new AbortController(),
    messageId: 'test-message',
    readFileTimestamps: {},
    options: {
      commands: [],
      tools: [],
      verbose: false,
      safeMode: false,
      forkNumber: 0,
      messageLogName: 'test',
      toolPermissionContext,
    },
  }
}

describe('Bash permission dont-ask-again (prefix) parity', () => {
  beforeEach(() => {
    __resetToolPermissionContextStateForTests()
    BunShell.restart()

    const current = getCurrentProjectConfig()
    saveCurrentProjectConfig({
      ...current,
      allowedTools: [],
      deniedTools: [],
      askedTools: [],
    })
  })

  test('prefix allow takes effect immediately in same turn after savePermission()', async () => {
    if (process.platform === 'win32') return

    const originalCwd = getCwd()
    const projectDir = mkdtempSync(join(tmpdir(), 'kode-p024-'))
    await setCwd(projectDir)

    try {
      const toolPermissionContext = createDefaultToolPermissionContext()
      toolPermissionContext.mode = 'cautious'

      const conversationKey = 'test:0'
      setToolPermissionContextForConversationKey({
        conversationKey,
        context: toolPermissionContext,
      })

      const ctx = makeToolUseContext(toolPermissionContext)

      const input = { command: 'python3 -V' }
      const before = await hasPermissionsToUseTool(
        BashTool,
        input,
        ctx,
        createAssistantMessage(''),
      )
      expect(before.result).toBe(false)

      await savePermission(BashTool, input, 'python3', ctx)

      const after = await hasPermissionsToUseTool(
        BashTool,
        input,
        ctx,
        createAssistantMessage(''),
      )
      expect(after).toEqual({ result: true })
      expect(
        ctx.options?.toolPermissionContext?.alwaysAllowRules?.localSettings ??
          [],
      ).toContain('Bash(python3:*)')
    } finally {
      await setCwd(originalCwd)
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  test('prefix allow persists to .kode/settings.local.json and reloads on restart', async () => {
    if (process.platform === 'win32') return

    const originalCwd = getCwd()
    const projectDir = mkdtempSync(join(tmpdir(), 'kode-p024-'))
    const homeDir = mkdtempSync(join(tmpdir(), 'kode-home-'))
    await setCwd(projectDir)

    try {
      const toolPermissionContext = createDefaultToolPermissionContext()
      toolPermissionContext.mode = 'cautious'

      const conversationKey = 'test:0'
      setToolPermissionContextForConversationKey({
        conversationKey,
        context: toolPermissionContext,
      })

      const ctx = makeToolUseContext(toolPermissionContext)
      const input = { command: 'python3 -V' }

      await savePermission(BashTool, input, 'python3', ctx)

      const settingsPath = join(projectDir, '.kode', 'settings.local.json')
      const raw = readFileSync(settingsPath, 'utf-8')
      const parsed = JSON.parse(raw)
      expect(parsed.permissions.allow).toContain('Bash(python3:*)')

      // Simulate restart by loading a fresh toolPermissionContext from disk.
      const reloaded = loadToolPermissionContextFromDisk({
        projectDir,
        homeDir,
        includeKodeProjectConfig: false,
        isBypassPermissionsModeAvailable: false,
      })

      const result = await checkBashPermissions({
        command: input.command,
        toolPermissionContext: reloaded,
        toolUseContext: makeToolUseContext(reloaded),
      })
      expect(result).toEqual({ result: true })
    } finally {
      await setCwd(originalCwd)
      rmSync(projectDir, { recursive: true, force: true })
      rmSync(homeDir, { recursive: true, force: true })
    }
  })

  test('prefix allow does not bypass dangerous rm -rf / in compound commands', async () => {
    const toolPermissionContext = createDefaultToolPermissionContext()
    toolPermissionContext.mode = 'cautious'
    toolPermissionContext.alwaysAllowRules.localSettings = ['Bash(echo:*)']

    const result = await checkBashPermissions({
      command: 'echo ok && rm -rf /',
      toolPermissionContext,
      toolUseContext: makeToolUseContext(toolPermissionContext),
    })

    expect(result.result).toBe(false)
    if (result.result !== false) {
      throw new Error('Expected permission denied result')
    }
    expect(result.shouldPromptUser).not.toBe(false)
  })
})
