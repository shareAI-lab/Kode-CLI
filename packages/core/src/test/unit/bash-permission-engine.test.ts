import { describe, expect, test, beforeEach } from 'bun:test'
import { createDefaultToolPermissionContext } from '#core/types/toolPermissionContext'
import {
  checkBashPermissions,
  checkBashPermissionsAutoAllowedBySandbox,
} from '@kode/permissions/bash'
import { hasPermissionsToUseTool } from '#core/permissions'
import { BashTool } from '#tools/tools/system/BashTool/BashTool'
import {
  getCurrentProjectConfig,
  saveCurrentProjectConfig,
} from '#core/utils/config'
import type { ToolUseContext } from '#core/tooling/Tool'
import type { PermissionMode } from '#core/types/PermissionMode'
import { createAssistantMessage } from '#core/utils/messages'

function makeToolUseContext(
  permissionMode: PermissionMode = 'cautious',
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
      permissionMode,
    },
  }
}

describe('Bash permission engine parity', () => {
  beforeEach(() => {
    const current = getCurrentProjectConfig()
    saveCurrentProjectConfig({
      ...current,
      allowedTools: [],
      deniedTools: [],
      askedTools: [],
    })
  })

  test('allows when prefix rule matches single command', async () => {
    const toolPermissionContext = createDefaultToolPermissionContext()
    toolPermissionContext.alwaysAllowRules.localSettings = ['Bash(git:*)']

    const result = await checkBashPermissions({
      command: 'git status',
      toolPermissionContext,
      toolUseContext: makeToolUseContext(),
    })

    expect(result).toEqual({ result: true })
  })

  test('allows when prompt rule matches Bash description', async () => {
    const toolPermissionContext = createDefaultToolPermissionContext()
    toolPermissionContext.alwaysAllowRules.localSettings = [
      'BashPrompt(run tests)',
    ]

    const result = await checkBashPermissions({
      command: 'bun test',
      description: 'Run tests',
      toolPermissionContext,
      toolUseContext: makeToolUseContext(),
    })

    expect(result).toEqual({ result: true })
  })

  test('prompt rules do not auto-allow compound commands', async () => {
    const toolPermissionContext = createDefaultToolPermissionContext()
    toolPermissionContext.alwaysAllowRules.localSettings = [
      'BashPrompt(run tests)',
    ]

    const result = await checkBashPermissions({
      command: 'bun test && echo ok',
      description: 'Run tests',
      toolPermissionContext,
      toolUseContext: makeToolUseContext(),
    })

    expect(result.result).toBe(false)
  })

  test('ask prompt rules override allow prompt rules', async () => {
    const toolPermissionContext = createDefaultToolPermissionContext()
    toolPermissionContext.alwaysAllowRules.localSettings = [
      'BashPrompt(run tests)',
    ]
    toolPermissionContext.alwaysAskRules.localSettings = [
      'BashPrompt(run tests)',
    ]

    const result = await checkBashPermissions({
      command: 'bun test',
      description: 'Run tests',
      toolPermissionContext,
      toolUseContext: makeToolUseContext(),
    })

    expect(result.result).toBe(false)
    if (result.result !== false) throw new Error('Expected permission prompt')
    expect(result.shouldPromptUser).not.toBe(false)
  })

  test('deny prompt rules override allow prompt rules', async () => {
    const toolPermissionContext = createDefaultToolPermissionContext()
    toolPermissionContext.alwaysAllowRules.localSettings = [
      'BashPrompt(run tests)',
    ]
    toolPermissionContext.alwaysDenyRules.localSettings = [
      'BashPrompt(run tests)',
    ]

    const result = await checkBashPermissions({
      command: 'bun test',
      description: 'Run tests',
      toolPermissionContext,
      toolUseContext: makeToolUseContext(),
    })

    expect(result).toMatchObject({
      result: false,
      shouldPromptUser: false,
      decisionReason: 'BashPrompt(run tests)',
    })
  })

  test('prefix rules do not match command names without a space separator', async () => {
    const toolPermissionContext = createDefaultToolPermissionContext()
    toolPermissionContext.alwaysAllowRules.localSettings = ['Bash(git:*)']

    const result = await checkBashPermissions({
      command: 'gitstatus',
      toolPermissionContext,
      toolUseContext: makeToolUseContext(),
    })

    expect(result.result).toBe(false)
  })

  test('allows when wildcard rule matches', async () => {
    const toolPermissionContext = createDefaultToolPermissionContext()
    toolPermissionContext.alwaysAllowRules.localSettings = ['Bash(git * main)']

    const result = await checkBashPermissions({
      command: 'git checkout main',
      toolPermissionContext,
      toolUseContext: makeToolUseContext(),
    })

    expect(result).toEqual({ result: true })
  })

  test('wildcard rules do not allow compound commands (&&)', async () => {
    const toolPermissionContext = createDefaultToolPermissionContext()
    toolPermissionContext.mode = 'cautious'
    toolPermissionContext.alwaysAllowRules.localSettings = ['Bash(git *)']

    const result = await checkBashPermissions({
      command: 'git status && rm -rf tmp',
      toolPermissionContext,
      toolUseContext: makeToolUseContext(),
    })

    expect(result.result).toBe(false)
  })

  test('wildcard rules do not allow compound commands (&)', async () => {
    const toolPermissionContext = createDefaultToolPermissionContext()
    toolPermissionContext.mode = 'cautious'
    toolPermissionContext.alwaysAllowRules.localSettings = ['Bash(git *)']

    const result = await checkBashPermissions({
      command: 'git status & rm -rf tmp',
      toolPermissionContext,
      toolUseContext: makeToolUseContext(),
    })

    expect(result.result).toBe(false)
  })

  test('wildcard rules do not allow compound commands (|&)', async () => {
    const toolPermissionContext = createDefaultToolPermissionContext()
    toolPermissionContext.mode = 'cautious'
    toolPermissionContext.alwaysAllowRules.localSettings = ['Bash(git *)']

    const result = await checkBashPermissions({
      command: 'git status |& rm -rf tmp',
      toolPermissionContext,
      toolUseContext: makeToolUseContext(),
    })

    expect(result.result).toBe(false)
  })

  test('treats &> as output redirection (not a command separator)', async () => {
    const toolPermissionContext = createDefaultToolPermissionContext()
    toolPermissionContext.alwaysAllowRules.localSettings = ['Bash(echo:*)']

    const result = await checkBashPermissions({
      command: 'echo hi &> out.txt',
      toolPermissionContext,
      toolUseContext: makeToolUseContext(),
    })

    expect(result).toEqual({ result: true })
  })

  test('ask wildcard overrides allow wildcard', async () => {
    const toolPermissionContext = createDefaultToolPermissionContext()
    toolPermissionContext.alwaysAllowRules.localSettings = ['Bash(git *)']
    toolPermissionContext.alwaysAskRules.localSettings = ['Bash(git * main)']

    const result = await checkBashPermissions({
      command: 'git checkout main',
      toolPermissionContext,
      toolUseContext: makeToolUseContext(),
    })

    expect(result.result).toBe(false)
    if (result.result !== false) throw new Error('Expected permission prompt')
    expect(result.shouldPromptUser).not.toBe(false)
  })

  test('deny overrides allow (exact deny beats prefix allow)', async () => {
    const toolPermissionContext = createDefaultToolPermissionContext()
    toolPermissionContext.alwaysAllowRules.localSettings = ['Bash(git:*)']
    toolPermissionContext.alwaysDenyRules.localSettings = ['Bash(git status)']

    const result = await checkBashPermissions({
      command: 'git status',
      toolPermissionContext,
      toolUseContext: makeToolUseContext(),
    })

    expect(result).toMatchObject({
      result: false,
      message:
        'Permission to use Bash with command git status has been denied.',
      shouldPromptUser: false,
      decisionReason: 'Bash(git status)',
    })
  })

  test('sandbox auto-allow does not bypass deny rules in compound commands', async () => {
    const toolPermissionContext = createDefaultToolPermissionContext()
    toolPermissionContext.alwaysDenyRules.localSettings = ['Bash(rm -rf tmp)']

    const result = checkBashPermissionsAutoAllowedBySandbox({
      command: 'echo ok && rm -rf tmp',
      toolPermissionContext,
    })

    expect(result).toMatchObject({
      result: false,
      shouldPromptUser: false,
      decisionReason: 'Bash(rm -rf tmp)',
    })
  })

  test('deny rules cannot be bypassed via shell line continuation', async () => {
    const toolPermissionContext = createDefaultToolPermissionContext()
    toolPermissionContext.alwaysDenyRules.localSettings = ['Bash(rm -rf /)']

    const continued = 'r\\\nm -rf /'
    const sandboxed = checkBashPermissionsAutoAllowedBySandbox({
      command: continued,
      toolPermissionContext,
    })

    expect(sandboxed).toMatchObject({
      result: false,
      shouldPromptUser: false,
      decisionReason: 'Bash(rm -rf /)',
    })

    const interactive = await checkBashPermissions({
      command: continued,
      toolPermissionContext,
      toolUseContext: makeToolUseContext(),
    })

    expect(interactive).toMatchObject({
      result: false,
      shouldPromptUser: false,
      decisionReason: 'Bash(rm -rf /)',
    })
  })

  test('line continuation cannot bypass deny within compound commands', async () => {
    const toolPermissionContext = createDefaultToolPermissionContext()
    toolPermissionContext.alwaysDenyRules.localSettings = ['Bash(rm -rf /)']
    toolPermissionContext.alwaysAllowRules.localSettings = ['Bash(echo:*)']

    const continued = 'echo hi; r\\\nm -rf /'
    const result = await checkBashPermissions({
      command: continued,
      toolPermissionContext,
      toolUseContext: makeToolUseContext(),
    })

    expect(result).toMatchObject({
      result: false,
      shouldPromptUser: false,
      decisionReason: 'Bash(rm -rf /)',
    })
  })

  test('ask overrides allow', async () => {
    const toolPermissionContext = createDefaultToolPermissionContext()
    toolPermissionContext.alwaysAllowRules.localSettings = ['Bash(git:*)']
    toolPermissionContext.alwaysAskRules.localSettings = ['Bash(git status)']

    const result = await checkBashPermissions({
      command: 'git status',
      toolPermissionContext,
      toolUseContext: makeToolUseContext(),
    })

    expect(result.result).toBe(false)
    if (result.result !== false) throw new Error('Expected permission prompt')
    expect(result.shouldPromptUser).not.toBe(false)
  })

  test('command injection check requires approval', async () => {
    const toolPermissionContext = createDefaultToolPermissionContext()

    const result = await checkBashPermissions({
      command: 'echo $(id)',
      toolPermissionContext,
      toolUseContext: makeToolUseContext(),
    })

    expect(result.result).toBe(false)
    if (result.result !== false) throw new Error('Expected permission prompt')
    expect(result.shouldPromptUser).not.toBe(false)
    expect(result.message).toContain('$()')
  })

  test('Ask mode requests approval for promptable Bash tool use', async () => {
    const ctx = makeToolUseContext('cautious')
    const result = await hasPermissionsToUseTool(
      BashTool,
      { command: 'echo hi' },
      ctx,
      createAssistantMessage(''),
    )

    expect(result.result).toBe(false)
    if (result.result !== false) throw new Error('Expected permission request')
    expect(result.shouldPromptUser).not.toBe(false)
  })
})
