import { describe, expect, test } from 'bun:test'

import { ask } from './ask'

describe('ask(): system prompt flags', () => {
  test('passes systemPromptOverride + appendSystemPrompt to buildSystemPromptForSession()', async () => {
    let captured: any = null

    const out = await ask(
      {
        commands: [] as any,
        tools: [] as any,
        hasPermissionsToUseTool: (() => ({ result: true })) as any,
        messageLogName: 'test',
        prompt: 'hi',
        cwd: '/tmp',
        systemPromptOverride: 'OVERRIDE',
        appendSystemPrompt: 'APPEND',
      },
      {
        setCwd: async () => {},
        getCurrentOutputStyleDefinition: () => null,
        buildSystemPromptForSession: async args => {
          captured = args
          return ['DEFAULT']
        },
        getContext: async () => ({}),
        getMaxThinkingTokens: async () => 0,
        query: async function* () {
          yield {
            type: 'assistant',
            uuid: 'assistant-uuid',
            message: { content: [{ type: 'text', text: 'ok' }] },
          } as any
        },
        getMessagesPath: () => 'messages.json',
        overwriteLog: () => {},
        getTotalCost: () => 0,
      },
    )

    expect(captured?.systemPromptOverride).toBe('OVERRIDE')
    expect(captured?.appendSystemPrompt).toBe('APPEND')
    expect(out.resultText).toBe('ok')
    expect(out.messageHistoryFile).toBe('messages.json')
  })

  test('passes appendSystemPrompt even when systemPromptOverride is empty', async () => {
    let captured: any = null

    await ask(
      {
        commands: [] as any,
        tools: [] as any,
        hasPermissionsToUseTool: (() => ({ result: true })) as any,
        messageLogName: 'test',
        prompt: 'hi',
        cwd: '/tmp',
        systemPromptOverride: '',
        appendSystemPrompt: 'APPEND',
      },
      {
        setCwd: async () => {},
        getCurrentOutputStyleDefinition: () => null,
        buildSystemPromptForSession: async args => {
          captured = args
          return ['DEFAULT']
        },
        getContext: async () => ({}),
        getMaxThinkingTokens: async () => 0,
        query: async function* () {
          yield {
            type: 'assistant',
            uuid: 'assistant-uuid',
            message: { content: [{ type: 'text', text: 'ok' }] },
          } as any
        },
        getMessagesPath: () => 'messages.json',
        overwriteLog: () => {},
        getTotalCost: () => 0,
      },
    )

    expect(captured?.systemPromptOverride).toBe('')
    expect(captured?.appendSystemPrompt).toBe('APPEND')
  })

  test('returns text content when a thinking block comes first', async () => {
    const out = await ask(
      {
        commands: [] as any,
        tools: [] as any,
        hasPermissionsToUseTool: (() => ({ result: true })) as any,
        messageLogName: 'test',
        prompt: 'what is 2+2?',
        cwd: '/tmp',
      },
      {
        setCwd: async () => {},
        getCurrentOutputStyleDefinition: () => null,
        buildSystemPromptForSession: async () => ['DEFAULT'],
        getContext: async () => ({}),
        getMaxThinkingTokens: async () => 0,
        query: async function* () {
          yield {
            type: 'assistant',
            uuid: 'assistant-uuid',
            message: {
              content: [
                {
                  type: 'thinking',
                  thinking:
                    'The user asked a simple arithmetic question; answer directly.',
                  signature: '',
                },
                { type: 'text', text: '4' },
              ],
            },
          } as any
        },
        getMessagesPath: () => 'messages.json',
        overwriteLog: () => {},
        getTotalCost: () => 0,
      },
    )

    expect(out.resultText).toBe('4')
  })

  test('passes headless permissions and runtime options to query()', async () => {
    let capturedContext: any = null
    const toolPermissionContext = {
      mode: 'acceptEdits',
      additionalWorkingDirectories: new Map(),
      alwaysAllowRules: { cliArg: ['Write(output.html)'] },
      alwaysDenyRules: {},
      alwaysAskRules: {},
      isBypassPermissionsModeAvailable: true,
    } as any
    const mcpClients = [{ name: 'test-mcp' }] as any

    await ask(
      {
        commands: [] as any,
        tools: [] as any,
        hasPermissionsToUseTool: (() => ({ result: true })) as any,
        messageLogName: 'test',
        prompt: 'write it',
        cwd: '/tmp',
        toolPermissionContext,
        shouldAvoidPermissionPrompts: true,
        model: 'task',
        mcpClients,
      },
      {
        setCwd: async () => {},
        getCurrentOutputStyleDefinition: () => null,
        buildSystemPromptForSession: async () => ['DEFAULT'],
        getContext: async () => ({}),
        getMaxThinkingTokens: async () => 0,
        query: async function* (
          _messages,
          _system,
          _context,
          _canUseTool,
          toolUseContext,
        ) {
          capturedContext = toolUseContext
          yield {
            type: 'assistant',
            uuid: 'assistant-uuid',
            message: { content: [{ type: 'text', text: 'ok' }] },
          } as any
        },
        getMessagesPath: () => 'messages.json',
        overwriteLog: () => {},
        getTotalCost: () => 0,
      },
    )

    expect(capturedContext.options.toolPermissionContext).toBe(
      toolPermissionContext,
    )
    expect(capturedContext.options.shouldAvoidPermissionPrompts).toBe(true)
    expect(capturedContext.options.model).toBe('task')
    expect(capturedContext.options.mcpClients).toBe(mcpClients)
  })
})
