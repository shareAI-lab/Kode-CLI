import { beforeEach, describe, expect, test } from 'bun:test'
import { createDefaultToolPermissionContext } from '#core/types/toolPermissionContext'
import { hasPermissionsToUseTool } from '#core/permissions'
import { WebFetchTool } from '#tools/tools/network/WebFetchTool/WebFetchTool'
import { WebSearchTool } from '#tools/tools/search/WebSearchTool/WebSearchTool'
import {
  getCurrentProjectConfig,
  saveCurrentProjectConfig,
} from '#core/utils/config'
import type { ToolUseContext } from '#core/tooling/Tool'
import type { ToolPermissionContext } from '#core/types/toolPermissionContext'
import type { PermissionMode } from '#core/types/PermissionMode'
import { createAssistantMessage } from '#core/utils/messages'

function makeToolUseContext(
  toolPermissionContext: ToolPermissionContext,
  permissionMode: PermissionMode = 'default',
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
      toolPermissionContext,
    },
  }
}

describe('Web tool permission rules (compatibility)', () => {
  beforeEach(() => {
    const current = getCurrentProjectConfig()
    saveCurrentProjectConfig({
      ...current,
      allowedTools: [],
      deniedTools: [],
      askedTools: [],
    })
  })

  test('WebFetch uses domain:<hostname> key for valid URLs', async () => {
    const toolPermissionContext = createDefaultToolPermissionContext()
    toolPermissionContext.alwaysAllowRules.localSettings = [
      'WebFetch(domain:example.com)',
    ]

    const result = await hasPermissionsToUseTool(
      WebFetchTool,
      { url: 'https://example.com', prompt: '' },
      makeToolUseContext(toolPermissionContext),
      createAssistantMessage(''),
    )

    expect(result).toEqual({ result: true })
  })

  test('WebFetch supports wildcard domain rules', async () => {
    const toolPermissionContext = createDefaultToolPermissionContext()
    toolPermissionContext.alwaysAllowRules.localSettings = [
      'WebFetch(domain:*.example.com)',
    ]

    const result = await hasPermissionsToUseTool(
      WebFetchTool,
      { url: 'https://api.example.com', prompt: '' },
      makeToolUseContext(toolPermissionContext),
      createAssistantMessage(''),
    )

    expect(result).toEqual({ result: true })
  })

  test('WebFetch deny rules override allow rules', async () => {
    const toolPermissionContext = createDefaultToolPermissionContext()
    toolPermissionContext.alwaysAllowRules.localSettings = [
      'WebFetch(domain:*.example.com)',
    ]
    toolPermissionContext.alwaysDenyRules.localSettings = [
      'WebFetch(domain:api.example.com)',
    ]

    const result = await hasPermissionsToUseTool(
      WebFetchTool,
      { url: 'https://api.example.com', prompt: '' },
      makeToolUseContext(toolPermissionContext),
      createAssistantMessage(''),
    )

    expect(result).toEqual({
      result: false,
      shouldPromptUser: false,
      message: 'Permission to use WebFetch has been denied.',
      decisionReason: 'WebFetch(domain:api.example.com)',
    })
  })

  test('WebFetch prompts when no rules match', async () => {
    const toolPermissionContext = createDefaultToolPermissionContext()

    const result = await hasPermissionsToUseTool(
      WebFetchTool,
      { url: 'https://example.com', prompt: '' },
      makeToolUseContext(toolPermissionContext),
      createAssistantMessage(''),
    )

    expect(result.result).toBe(false)
    if (result.result !== false) {
      throw new Error('Expected permission denied result')
    }
    expect(result.shouldPromptUser).not.toBe(false)
    expect(result.message).toContain('requested permissions to use WebFetch')
  })

  test('WebFetch falls back to input:<raw> when schema parsing fails', async () => {
    const toolPermissionContext = createDefaultToolPermissionContext()
    toolPermissionContext.alwaysAllowRules.localSettings = [
      'WebFetch(input:hello)',
    ]

    const result = await hasPermissionsToUseTool(
      WebFetchTool,
      'hello' as unknown as Record<string, unknown>,
      makeToolUseContext(toolPermissionContext),
      createAssistantMessage(''),
    )

    expect(result).toEqual({ result: true })
  })

  test('WebSearch uses query-based keys (WebSearch(<query>)) with WebSearch allow-all fallback', async () => {
    const toolPermissionContext = createDefaultToolPermissionContext()
    toolPermissionContext.alwaysAllowRules.localSettings = [
      'WebSearch(claude ai)',
    ]

    const allowed = await hasPermissionsToUseTool(
      WebSearchTool,
      { query: 'claude ai' },
      makeToolUseContext(toolPermissionContext),
      createAssistantMessage(''),
    )

    expect(allowed).toEqual({ result: true })

    toolPermissionContext.alwaysAllowRules.localSettings = ['WebSearch']
    const allowAll = await hasPermissionsToUseTool(
      WebSearchTool,
      { query: 'some other query' },
      makeToolUseContext(toolPermissionContext),
      createAssistantMessage(''),
    )

    expect(allowAll).toEqual({ result: true })
  })
})
