import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { createDefaultToolPermissionContext } from '#core/types/toolPermissionContext'
import { hasPermissionsToUseTool } from '#core/permissions'
import { BashTool } from '#tools/tools/system/BashTool/BashTool'
import type { ToolUseContext } from '#core/tooling/Tool'
import type { ToolPermissionContext } from '#core/types/toolPermissionContext'
import { createAssistantMessage } from '#core/utils/messages'

function writeJson(filePath: string, value: unknown) {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8')
}

function makeToolUseContext(
  toolPermissionContext: ToolPermissionContext,
  overrides: { projectDir: string; homeDir: string },
): ToolUseContext {
  return {
    abortController: new AbortController(),
    messageId: 'test',
    readFileTimestamps: {},
    options: {
      commands: [],
      tools: [],
      verbose: false,
      safeMode: false,
      forkNumber: 0,
      messageLogName: 'test',
      maxThinkingTokens: 0,
      permissionMode: 'cautious',
      toolPermissionContext,
      __sandboxProjectDir: overrides.projectDir,
      __sandboxHomeDir: overrides.homeDir,
      __sandboxPlatform: 'linux',
      __sandboxBwrapPath: '/usr/bin/bwrap',
      __sandboxSocatPath: '/usr/bin/socat',
    },
  }
}

describe('Bash sandbox permission matrix (compatibility)', () => {
  let projectDir: string
  let homeDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'kode-bash-sandbox-project-'))
    homeDir = mkdtempSync(join(tmpdir(), 'kode-bash-sandbox-home-'))
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
    rmSync(homeDir, { recursive: true, force: true })
  })

  test('autoAllowBashIfSandboxed: sandboxed Bash is allowed by default (no allow rule needed)', async () => {
    writeJson(join(projectDir, '.claude', 'settings.json'), {
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: true,
      },
    })

    const toolPermissionContext = createDefaultToolPermissionContext()
    const result = await hasPermissionsToUseTool(
      BashTool,
      { command: 'echo hi' },
      makeToolUseContext(toolPermissionContext, { projectDir, homeDir }),
      createAssistantMessage(''),
    )

    expect(result).toEqual({ result: true })
  })

  test('deny rules still override auto-allow when sandboxed', async () => {
    writeJson(join(projectDir, '.claude', 'settings.json'), {
      sandbox: { enabled: true, autoAllowBashIfSandboxed: true },
    })

    const toolPermissionContext = createDefaultToolPermissionContext()
    toolPermissionContext.mode = 'cautious'
    toolPermissionContext.alwaysDenyRules.localSettings = ['Bash(echo hi)']

    const result = await hasPermissionsToUseTool(
      BashTool,
      { command: 'echo hi' },
      makeToolUseContext(toolPermissionContext, { projectDir, homeDir }),
      createAssistantMessage(''),
    )

    expect(result).toEqual({
      result: false,
      shouldPromptUser: false,
      message: 'Permission to use Bash with command echo hi has been denied.',
      decisionReason: 'Bash(echo hi)',
    })
  })

  test('ask rules still trigger prompts even when sandboxed', async () => {
    writeJson(join(projectDir, '.claude', 'settings.json'), {
      sandbox: { enabled: true, autoAllowBashIfSandboxed: true },
    })

    const toolPermissionContext = createDefaultToolPermissionContext()
    toolPermissionContext.mode = 'cautious'
    toolPermissionContext.alwaysAskRules.localSettings = ['Bash(echo:*)']

    const result = await hasPermissionsToUseTool(
      BashTool,
      { command: 'echo hi' },
      makeToolUseContext(toolPermissionContext, { projectDir, homeDir }),
      createAssistantMessage(''),
    )

    expect(result.result).toBe(false)
    if (result.result !== false) {
      throw new Error('Expected permission denied result')
    }
    expect(result.shouldPromptUser).not.toBe(false)
    expect(result.message).toContain('requested permissions to use Bash')
  })

  test('excludedCommands disables auto-allow (falls back to normal Bash permission prompts)', async () => {
    writeJson(join(projectDir, '.claude', 'settings.json'), {
      sandbox: { enabled: true, excludedCommands: ['echo:*'] },
    })

    const toolPermissionContext = createDefaultToolPermissionContext()
    toolPermissionContext.mode = 'acceptEdits'
    const result = await hasPermissionsToUseTool(
      BashTool,
      { command: 'echo hi' },
      makeToolUseContext(toolPermissionContext, { projectDir, homeDir }),
      createAssistantMessage(''),
    )

    expect(result.result).toBe(false)
    if (result.result !== false) {
      throw new Error('Expected permission denied result')
    }
    expect(result.shouldPromptUser).not.toBe(false)
    expect(result.message).toContain('requested permissions to use Bash')
  })

  test('allowUnsandboxedCommands=false ignores dangerouslyDisableSandbox and stays sandboxed', async () => {
    writeJson(join(projectDir, '.claude', 'settings.json'), {
      sandbox: { enabled: true, allowUnsandboxedCommands: false },
    })

    const toolPermissionContext = createDefaultToolPermissionContext()
    toolPermissionContext.mode = 'acceptEdits'
    const result = await hasPermissionsToUseTool(
      BashTool,
      { command: 'echo hi', dangerouslyDisableSandbox: true },
      makeToolUseContext(toolPermissionContext, { projectDir, homeDir }),
      createAssistantMessage(''),
    )

    expect(result).toEqual({ result: true })
  })
})
