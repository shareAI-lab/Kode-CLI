import { describe, expect, test, beforeEach } from 'bun:test'
import { hasPermissionsToUseTool } from '#core/permissions'
import {
  saveCurrentProjectConfig,
  getCurrentProjectConfig,
} from '#core/utils/config'
import { SlashCommandTool } from '#tools/tools/interaction/SlashCommandTool/SlashCommandTool'
import type { Tool, ToolUseContext } from '#core/tooling/Tool'
import { createAssistantMessage } from '#core/utils/messages'
import { z } from 'zod'

const makeContext = (): ToolUseContext => ({
  abortController: new AbortController(),
  messageId: 'test',
  options: {
    commands: [],
    tools: [],
    verbose: false,
    slowAndCapableModel: undefined,
    safeMode: true,
    permissionMode: 'cautious',
    forkNumber: 0,
    messageLogName: 'test',
    maxThinkingTokens: 0,
  },
  readFileTimestamps: {},
})

const toolStubSchema = z.object({}).passthrough()

function createPermissionToolStub(name: string): Tool {
  return {
    name,
    inputSchema: toolStubSchema,
    async prompt() {
      return ''
    },
    async isEnabled() {
      return true
    },
    isReadOnly() {
      return false
    },
    isConcurrencySafe() {
      return true
    },
    needsPermissions() {
      return true
    },
    renderResultForAssistant() {
      return ''
    },
    renderToolUseMessage() {
      return ''
    },
    call: async function* () {
      return
    },
  } as unknown as Tool
}

function setToolRules(rules: {
  allow?: string[]
  deny?: string[]
  ask?: string[]
}) {
  const current = getCurrentProjectConfig()
  saveCurrentProjectConfig({
    ...current,
    allowedTools: rules.allow ?? [],
    deniedTools: rules.deny ?? [],
    askedTools: rules.ask ?? [],
  })
}

describe('Permission rule matching (MCP + allow/deny/ask)', () => {
  beforeEach(() => {
    setToolRules({ allow: [], deny: [], ask: [] })
  })

  test('deny overrides allow for MCP dynamic tool names', async () => {
    const ctx = makeContext()
    const toolName = 'mcp__srv__tool'
    setToolRules({ allow: [toolName], deny: [toolName] })

    const fakeTool = createPermissionToolStub(toolName)

    const result = await hasPermissionsToUseTool(
      fakeTool,
      {},
      ctx,
      createAssistantMessage(''),
    )

    expect(result.result).toBe(false)
    if (result.result !== false) {
      throw new Error('Expected permission denied result')
    }
    expect(result.shouldPromptUser).toBe(false)
  })

  test('ask overrides allow for MCP dynamic tool names', async () => {
    const ctx = makeContext()
    const toolName = 'mcp__srv__tool'
    setToolRules({ allow: [toolName], ask: [toolName] })

    const fakeTool = createPermissionToolStub(toolName)

    const result = await hasPermissionsToUseTool(
      fakeTool,
      {},
      ctx,
      createAssistantMessage(''),
    )

    expect(result.result).toBe(false)
    if (result.result !== false) {
      throw new Error('Expected permission denied result')
    }
    expect(result.shouldPromptUser).not.toBe(false)
  })

  test('MCP permissions do not apply across servers', async () => {
    const ctx = makeContext()
    setToolRules({ allow: ['mcp__srv1__tool'] })

    const fakeTool = createPermissionToolStub('mcp__srv2__tool')

    const result = await hasPermissionsToUseTool(
      fakeTool,
      {},
      ctx,
      createAssistantMessage(''),
    )

    expect(result.result).toBe(false)
    if (result.result !== false) {
      throw new Error('Expected permission denied result')
    }
    expect(result.shouldPromptUser).not.toBe(false)
  })

  test('MCP wildcard mcp__server__* allows all tools from that server', async () => {
    const ctx = makeContext()
    setToolRules({ allow: ['mcp__srv__*'] })

    const fakeTool = createPermissionToolStub('mcp__srv__toolA')

    const result = await hasPermissionsToUseTool(
      fakeTool,
      {},
      ctx,
      createAssistantMessage(''),
    )
    expect(result.result).toBe(true)
  })

  test('MCP wildcard does not apply across servers', async () => {
    const ctx = makeContext()
    setToolRules({ allow: ['mcp__srv1__*'] })

    const fakeTool = createPermissionToolStub('mcp__srv2__tool')

    const result = await hasPermissionsToUseTool(
      fakeTool,
      {},
      ctx,
      createAssistantMessage(''),
    )
    expect(result.result).toBe(false)
    if (result.result !== false) {
      throw new Error('Expected permission denied result')
    }
    expect(result.shouldPromptUser).not.toBe(false)
  })

  test('deny wildcard overrides allow exact for MCP tools', async () => {
    const ctx = makeContext()
    setToolRules({ allow: ['mcp__srv__tool'], deny: ['mcp__srv__*'] })

    const fakeTool = createPermissionToolStub('mcp__srv__tool')

    const result = await hasPermissionsToUseTool(
      fakeTool,
      {},
      ctx,
      createAssistantMessage(''),
    )
    expect(result.result).toBe(false)
    if (result.result !== false) {
      throw new Error('Expected permission denied result')
    }
    expect(result.shouldPromptUser).toBe(false)
  })

  test('ask wildcard overrides allow wildcard for MCP tools', async () => {
    const ctx = makeContext()
    setToolRules({ allow: ['mcp__srv__*'], ask: ['mcp__srv__*'] })

    const fakeTool = createPermissionToolStub('mcp__srv__tool')

    const result = await hasPermissionsToUseTool(
      fakeTool,
      {},
      ctx,
      createAssistantMessage(''),
    )
    expect(result.result).toBe(false)
    if (result.result !== false) {
      throw new Error('Expected permission denied result')
    }
    expect(result.shouldPromptUser).not.toBe(false)
  })

  test('deny prefix rules apply to SlashCommand', async () => {
    const ctx = makeContext()
    setToolRules({ deny: ['SlashCommand(/review-pr:*)'] })

    const result = await hasPermissionsToUseTool(
      SlashCommandTool,
      { command: '/review-pr 123' },
      ctx,
      createAssistantMessage(''),
    )

    expect(result.result).toBe(false)
    if (result.result !== false) {
      throw new Error('Expected permission denied result')
    }
    expect(result.shouldPromptUser).toBe(false)
  })

  test('ask prefix rules override allow for SlashCommand', async () => {
    const ctx = makeContext()
    setToolRules({
      allow: ['SlashCommand(/review-pr:*)'],
      ask: ['SlashCommand(/review-pr:*)'],
    })

    const result = await hasPermissionsToUseTool(
      SlashCommandTool,
      { command: '/review-pr 123' },
      ctx,
      createAssistantMessage(''),
    )

    expect(result.result).toBe(false)
    if (result.result !== false) {
      throw new Error('Expected permission denied result')
    }
    expect(result.shouldPromptUser).not.toBe(false)
  })
})
