import { describe, expect, test } from 'bun:test'
import { z } from 'zod'

import {
  CodexAppServerTurnError,
  queryCodexOAuth,
} from '#core/ai/llm/codexOAuth'
import { createUserMessage } from '#core/utils/messages'
import type { ExternalRuntimeToolCall } from '@kode/tool-interface/Tool'

type CodexAppServerHandlers = {
  onNotification(method: string, params: unknown): void
  onServerRequest(id: number | string, method: string, params: unknown): void
}

describe('Codex OAuth dynamic tool bridge', () => {
  test('registers Kode tools and returns their result through item/tool/call', async () => {
    let handlers: any
    const requests: Array<{ method: string; params: Record<string, unknown> }> =
      []
    const responses: Array<{
      id: number | string
      result: Record<string, unknown>
    }> = []
    const executed: unknown[] = []

    const message = await queryCodexOAuth(
      [createUserMessage('审查未提交改动')],
      ['Use tools for project inspection.'],
      0,
      [
        {
          name: 'Read',
          description: 'Read a file from the workspace.',
          inputSchema: z.object({ file_path: z.string() }),
          readModeAccess: 'always',
          isReadOnly: () => true,
          requiresUserInteraction: () => false,
        } as any,
      ],
      new AbortController().signal,
      {
        modelProfile: {
          modelName: 'codex-oauth:gpt-5.6-sol',
          externalModelId: 'gpt-5.6-sol',
          provider: 'codex-oauth',
          name: 'Codex OAuth',
          apiKey: '',
          maxTokens: 1,
          contextLength: 1,
          createdAt: 0,
          isActive: true,
        },
        toolUseContext: {
          options: {
            executeExternalToolCall: async (call: ExternalRuntimeToolCall) => {
              executed.push(call)
              return { success: true, content: 'workspace evidence' }
            },
          },
        } as any,
        __testClientFactory: (nextHandlers: CodexAppServerHandlers) => {
          handlers = nextHandlers
          return {
            start: async () => {},
            stop: async () => {},
            request: async (
              method: string,
              params: Record<string, unknown>,
            ) => {
              requests.push({ method, params })
              if (method === 'thread/start')
                return { thread: { id: 'thread-1' } }
              if (method === 'turn/start') {
                setTimeout(() => {
                  handlers.onServerRequest('rpc-1', 'item/tool/call', {
                    callId: 'tool-1',
                    threadId: 'thread-1',
                    turnId: 'turn-1',
                    tool: 'Read',
                    namespace: null,
                    arguments: { file_path: '/tmp/example.ts' },
                  })
                }, 0)
                return { turn: { id: 'turn-1' } }
              }
              throw new Error(`Unexpected request: ${method}`)
            },
            respond: (id: number | string, result: Record<string, unknown>) => {
              responses.push({ id, result })
              handlers.onNotification('turn/completed', {
                threadId: 'thread-1',
                turn: {
                  items: [{ type: 'agentMessage', text: 'Review complete.' }],
                },
              })
            },
            respondError: () => {},
          }
        },
      } as any,
    )

    const threadStart = requests.find(
      request => request.method === 'thread/start',
    )
    expect(threadStart?.params.dynamicTools).toEqual([
      expect.objectContaining({
        type: 'function',
        name: 'Read',
        description: 'Read a file from the workspace.',
      }),
    ])
    expect(executed).toEqual([
      {
        toolUseId: 'tool-1',
        toolName: 'Read',
        input: { file_path: '/tmp/example.ts' },
      },
    ])
    expect(responses).toEqual([
      {
        id: 'rpc-1',
        result: {
          success: true,
          contentItems: [{ type: 'inputText', text: 'workspace evidence' }],
        },
      },
    ])
    expect(message.message.content).toEqual([
      { type: 'text', text: 'Review complete.', citations: [] },
    ])
  })

  test('registers action-capable tools with their full input schemas', async () => {
    let handlers: CodexAppServerHandlers
    const requests: Array<{ method: string; params: Record<string, unknown> }> =
      []

    await queryCodexOAuth(
      [createUserMessage('审查未提交改动')],
      ['Use tools for project inspection.'],
      0,
      [
        {
          name: 'Read',
          description: 'Read a file from the workspace.',
          inputSchema: z.object({ file_path: z.string() }),
          readModeAccess: 'always',
          isReadOnly: () => true,
        },
        {
          name: 'Bash',
          description: 'Run shell command',
          inputSchema: z.object({
            command: z.string(),
            run_in_background: z.boolean().optional(),
            dangerouslyDisableSandbox: z.boolean().optional(),
          }),
          readModeInputSchema: z.strictObject({ command: z.string() }),
          readModeAccess: 'conditional',
          isReadOnly: (input: { command?: string }) =>
            input.command === 'git diff',
        },
        {
          name: 'Task',
          description: 'Launch a task',
          inputSchema: z.object({ prompt: z.string() }),
          isReadOnly: () => true,
        },
      ] as any,
      new AbortController().signal,
      {
        modelProfile: {
          modelName: 'codex-oauth:gpt-5.6-sol',
          externalModelId: 'gpt-5.6-sol',
          provider: 'codex-oauth',
          name: 'Codex OAuth',
          apiKey: '',
          maxTokens: 1,
          contextLength: 1,
          createdAt: 0,
          isActive: true,
        },
        toolUseContext: {
          options: {
            executeExternalToolCall: async () => ({
              success: true,
              content: 'unused',
            }),
          },
        } as any,
        __testClientFactory: (nextHandlers: CodexAppServerHandlers) => {
          handlers = nextHandlers
          return {
            start: async () => {},
            stop: async () => {},
            request: async (
              method: string,
              params: Record<string, unknown>,
            ) => {
              requests.push({ method, params })
              if (method === 'thread/start') {
                return { thread: { id: 'thread-1' } }
              }
              if (method === 'turn/start') {
                setTimeout(() => {
                  handlers.onNotification('turn/completed', {
                    threadId: 'thread-1',
                    turn: {
                      items: [
                        { type: 'agentMessage', text: 'Review complete.' },
                      ],
                    },
                  })
                }, 0)
                return { turn: { id: 'turn-1' } }
              }
              throw new Error(`Unexpected request: ${method}`)
            },
            respond: () => {},
            respondError: () => {},
          }
        },
      } as any,
    )

    const threadStart = requests.find(
      request => request.method === 'thread/start',
    )
    const dynamicTools = threadStart?.params.dynamicTools as Array<{
      name: string
      description: string
      inputSchema: { properties?: Record<string, unknown> }
    }>
    expect(dynamicTools.map(tool => tool.name)).toEqual([
      'Read',
      'Bash',
      'Task',
    ])

    const bash = dynamicTools.find(tool => tool.name === 'Bash')
    expect(bash?.description).toBe('Run shell command')
    expect(bash?.inputSchema.properties).toEqual(
      expect.objectContaining({
        command: expect.any(Object),
        run_in_background: expect.any(Object),
        dangerouslyDisableSandbox: expect.any(Object),
      }),
    )
  })

  test('preserves the runtime error supplied by a failed turn', async () => {
    let handlers: CodexAppServerHandlers

    const request = queryCodexOAuth(
      [createUserMessage('审查未提交改动')],
      ['Use tools for project inspection.'],
      0,
      [],
      new AbortController().signal,
      {
        modelProfile: {
          modelName: 'codex-oauth:gpt-5.6-sol',
          externalModelId: 'gpt-5.6-sol',
          provider: 'codex-oauth',
          name: 'Codex OAuth',
          apiKey: '',
          maxTokens: 1,
          contextLength: 1,
          createdAt: 0,
          isActive: true,
        },
        __testClientFactory: (nextHandlers: CodexAppServerHandlers) => {
          handlers = nextHandlers
          return {
            start: async () => {},
            stop: async () => {},
            request: async method => {
              if (method === 'thread/start') {
                return { thread: { id: 'thread-1' } }
              }
              if (method === 'turn/start') {
                setTimeout(() => {
                  handlers.onNotification('turn/completed', {
                    threadId: 'thread-1',
                    turn: {
                      status: 'failed',
                      error: { message: 'Provider rate limit reached.' },
                      items: [],
                    },
                  })
                }, 0)
                return { turn: { id: 'turn-1' } }
              }
              throw new Error(`Unexpected request: ${method}`)
            },
            respond: () => {},
            respondError: () => {},
          }
        },
      },
    )

    try {
      await request
      throw new Error('Expected the failed turn to reject')
    } catch (error) {
      expect(error).toBeInstanceOf(CodexAppServerTurnError)
      expect(error).toMatchObject({
        name: 'CodexAppServerTurnError',
        message: 'Codex app-server turn failed: Provider rate limit reached.',
      })
    }
  })
})
