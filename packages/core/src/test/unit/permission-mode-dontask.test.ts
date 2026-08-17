import { beforeEach, describe, expect, test } from 'bun:test'

import {
  getNextPermissionMode,
  MODE_CONFIGS,
  normalizePermissionMode,
  type PermissionMode,
} from '#core/types/PermissionMode'
import { hasPermissionsToUseTool } from '#core/permissions/engine'
import { createDefaultToolPermissionContext } from '#core/types/toolPermissionContext'
import { __resetPermissionModeStateForTests } from '#core/utils/permissionModeState'
import { __getModeIndicatorDisplayForTests } from '#ui-ink/components/ModeIndicator'
import { getTheme } from '#core/utils/theme'
import { BashTool } from '#tools/tools/system/BashTool/BashTool'

describe('three permission modes', () => {
  beforeEach(() => {
    __resetPermissionModeStateForTests()
  })

  test('exposes only Edit, Plan, and Ask modes', () => {
    const modes: PermissionMode[] = ['acceptEdits', 'plan', 'cautious']

    expect(Object.keys(MODE_CONFIGS).sort()).toEqual([...modes].sort())
    expect(MODE_CONFIGS.acceptEdits.label).toBe('Edit')
    expect(MODE_CONFIGS.plan.label).toBe('Plan')
    expect(MODE_CONFIGS.cautious.label).toBe('Ask')
  })

  test('maps legacy values onto the supported modes', () => {
    expect(normalizePermissionMode('yolo')).toBe('acceptEdits')
    expect(normalizePermissionMode('bypassPermissions')).toBe('acceptEdits')
    expect(normalizePermissionMode('default')).toBe('cautious')
    expect(normalizePermissionMode('dontAsk')).toBe('cautious')
  })

  test('cycles Edit -> Plan -> Ask -> Edit', () => {
    expect(getNextPermissionMode('acceptEdits')).toBe('plan')
    expect(getNextPermissionMode('plan')).toBe('cautious')
    expect(getNextPermissionMode('cautious')).toBe('acceptEdits')
  })

  test('Edit permits dependency installation and typechecking without a prompt', async () => {
    const ctx = {
      abortController: new AbortController(),
      messageId: 'test',
      options: {
        commands: [] as any[],
        tools: [] as any[],
        verbose: false,
        safeMode: false,
        forkNumber: 0,
        messageLogName: 'test-edit-perm',
        maxThinkingTokens: 0,
        shouldAvoidPermissionPrompts: true,
        toolPermissionContext: createDefaultToolPermissionContext(),
      },
      readFileTimestamps: {},
    }

    const result = await hasPermissionsToUseTool(
      BashTool,
      { command: 'bun install --frozen-lockfile && bun run typecheck' },
      ctx as any,
      {} as any,
    )

    expect(result.result).toBe(true)
  })

  test('Edit respects an explicit ask rule', async () => {
    const toolPermissionContext = createDefaultToolPermissionContext()
    toolPermissionContext.alwaysAskRules.session = ['Bash(bun:*)']
    const ctx = {
      abortController: new AbortController(),
      messageId: 'test',
      options: {
        commands: [] as any[],
        tools: [] as any[],
        verbose: false,
        safeMode: false,
        forkNumber: 0,
        messageLogName: 'test-edit-ask-rule',
        maxThinkingTokens: 0,
        toolPermissionContext,
      },
      readFileTimestamps: {},
    }

    const result = await hasPermissionsToUseTool(
      BashTool,
      { command: 'bun run typecheck' },
      ctx as any,
      {} as any,
    )

    expect(result.result).toBe(false)
    if (result.result !== false) throw new Error('Expected permission request')
    expect(result.requiresExplicitApproval).toBe(true)
  })

  test('safe mode forces a fresh Edit session to Ask', async () => {
    const ctx = {
      abortController: new AbortController(),
      messageId: 'test',
      options: {
        commands: [] as any[],
        tools: [] as any[],
        verbose: false,
        safeMode: true,
        forkNumber: 0,
        messageLogName: 'test-safe-perm',
        maxThinkingTokens: 0,
        toolPermissionContext: createDefaultToolPermissionContext(),
      },
      readFileTimestamps: {},
    }

    const result = await hasPermissionsToUseTool(
      BashTool,
      { command: 'bun run typecheck' },
      ctx as any,
      {} as any,
    )

    expect(result.result).toBe(false)
    if (result.result !== false) throw new Error('Expected permission request')
    expect(result.shouldPromptUser).not.toBe(false)
  })

  test('Ask mode exposes the Ask indicator', () => {
    const theme = getTheme('dark')
    const indicator = __getModeIndicatorDisplayForTests({
      mode: 'cautious',
      shortcutDisplayText: 'shift+tab',
      theme,
    })

    expect(indicator.color).toBe(theme.warning)
    expect(indicator.mainText).toBe('Tool permissions: Ask before tools')
  })
})
