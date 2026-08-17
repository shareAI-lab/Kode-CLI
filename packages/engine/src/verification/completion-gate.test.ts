import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { __setLlmLazyQueryLLMLoaderForTests } from '#core/ai/llmLazy'
import { createAssistantMessage, createUserMessage } from '../messages/create'
import { messagePipeline } from '../message-pipeline'
import type { AssistantMessage, Message } from '../pipeline/types'

const passedReceipt = {
  version: 1 as const,
  kind: 'test' as const,
  status: 'passed' as const,
  toolUseId: 'verify-1',
  commandDigest: 'a'.repeat(16),
  outputDigest: 'b'.repeat(16),
  recordedAt: '2026-08-10T00:00:00.000Z',
}

let queryImplementation = async (): Promise<AssistantMessage> =>
  createAssistantMessage('Done.')

const queryLLM = mock(async (...args: unknown[]) => {
  void args
  return queryImplementation()
})

function toolUse(
  id: string,
  name: string,
  input: Record<string, unknown>,
): Message {
  const message = createAssistantMessage('')
  return {
    ...message,
    message: {
      ...message.message,
      content: [{ type: 'tool_use', id, name, input }],
    },
  } as AssistantMessage
}

function toolResult(
  id: string,
  data: unknown,
  mutationScope?: 'none' | 'direct' | 'delegated',
): Message {
  return {
    ...createUserMessage([
      {
        type: 'tool_result',
        tool_use_id: id,
        content: 'tool output',
      },
    ]),
    toolUseResult: {
      data,
      resultForAssistant: 'tool output',
      ...(mutationScope
        ? {
            metadata: {
              workspaceMutation: {
                version: 1 as const,
                toolUseId: id,
                scope: mutationScope,
                basis:
                  mutationScope === 'delegated'
                    ? ('delegated' as const)
                    : ('observed' as const),
              },
            },
          }
        : {}),
    },
  }
}

function createContext(options?: { trustedBash?: boolean; maxTurns?: number }) {
  const trustedBash = options?.trustedBash ?? true
  return {
    abortController: new AbortController(),
    messageId: undefined,
    readFileTimestamps: {},
    setToolJSX: () => {},
    turnCount: 0,
    options: {
      commands: [],
      forkNumber: 0,
      messageLogName: 'verification-gate-test',
      tools: trustedBash
        ? [{ name: 'Bash', isTrustedExecutionTool: true }]
        : [],
      verbose: false,
      safeMode: false,
      maxThinkingTokens: 0,
      maxTurns: options?.maxTurns ?? 4,
      persistSession: false,
    },
  } as any
}

async function run(messages: Message[], context = createContext()) {
  const output: Message[] = []
  for await (const message of messagePipeline(
    messages,
    [],
    {},
    (async () => ({ result: true })) as any,
    context,
  )) {
    output.push(message)
  }
  return { output, context }
}

describe('interactive completion verification gate', () => {
  beforeEach(() => {
    queryLLM.mockClear()
    queryImplementation = async () => createAssistantMessage('Done.')
    __setLlmLazyQueryLLMLoaderForTests(async () => queryLLM)
  })

  afterEach(() => {
    __setLlmLazyQueryLLMLoaderForTests(null)
  })

  test('retries once and fails closed when a write has no later verification', async () => {
    const calls: Message[][] = []
    queryImplementation = async () =>
      createAssistantMessage('Done without checking.')
    queryLLM.mockImplementation(async (...args: unknown[]) => {
      calls.push(args[0] as Message[])
      return queryImplementation()
    })

    const { output, context } = await run([
      createUserMessage('Implement the requested change.'),
      toolUse('edit-1', 'Edit', { file_path: 'a.ts' }),
      toolResult('edit-1', {}),
    ])

    expect(queryLLM).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(calls[1])).toContain('<verification-recovery>')
    const last = output
      .filter(
        (message): message is AssistantMessage => message.type === 'assistant',
      )
      .at(-1)
    expect(last?.isApiErrorMessage).toBe(true)
    expect(last?.message.content[0]?.text).toContain('Verification incomplete')
    expect(context.turnCount).toBe(2)
  })

  test('accepts a trusted terminal receipt after the latest write', async () => {
    const { output, context } = await run([
      createUserMessage('Implement and test the requested change.'),
      toolUse('edit-1', 'Edit', { file_path: 'a.ts' }),
      toolResult('edit-1', {}),
      toolUse('verify-1', 'Bash', { command: 'bun test' }),
      toolResult('verify-1', { verification: passedReceipt }),
    ])

    expect(queryLLM).toHaveBeenCalledTimes(1)
    const assistants = output.filter(message => message.type === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0]?.isApiErrorMessage).not.toBe(true)
    expect(context.turnCount).toBe(1)
  })

  test('ignores writes from an older human turn', async () => {
    const { output } = await run([
      createUserMessage('Implement the requested change.'),
      toolUse('edit-1', 'Edit', { file_path: 'a.ts' }),
      toolResult('edit-1', {}),
      createUserMessage('Now explain the result without changing files.'),
    ])

    expect(queryLLM).toHaveBeenCalledTimes(1)
    expect(output.filter(message => message.type === 'assistant')).toHaveLength(
      1,
    )
  })

  test('returns normally after delegated read-only exploration', async () => {
    const { output, context } = await run([
      createUserMessage('Read the implementation and explain it.'),
      toolUse('task-1', 'Task', {
        subagent_type: 'Explore',
        prompt: 'Inspect the implementation without editing files.',
      }),
      toolResult('task-1', { status: 'completed' }, 'delegated'),
      toolUse('read-1', 'Read', { file_path: '/workspace/a.ts' }),
      toolResult('read-1', {}, 'none'),
    ])

    expect(queryLLM).toHaveBeenCalledTimes(1)
    const assistants = output.filter(message => message.type === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0]?.isApiErrorMessage).not.toBe(true)
    expect(context.turnCount).toBe(1)
  })

  test('preserves completion with a verification boundary when no trusted execution tool exists', async () => {
    const { output } = await run(
      [
        createUserMessage('Implement the requested change.'),
        toolUse('edit-1', 'Edit', { file_path: 'a.ts' }),
        toolResult('edit-1', {}),
      ],
      createContext({ trustedBash: false }),
    )

    expect(queryLLM).toHaveBeenCalledTimes(1)
    const last = output
      .filter(
        (message): message is AssistantMessage => message.type === 'assistant',
      )
      .at(-1)
    expect(last?.isApiErrorMessage).not.toBe(true)
    expect(last?.message.content[0]?.text).toContain('Done.')
    expect(last?.message.content[0]?.text).toContain(
      'Automated verification was not run',
    )
    expect(last?.message.content[0]?.text).toContain(
      'workspace changes applied by tools remain in place',
    )
  })

  test('localizes the no-terminal boundary for a Chinese completion', async () => {
    queryImplementation = async () => createAssistantMessage('已完成修改。')

    const { output } = await run(
      [
        createUserMessage('完成修改。'),
        toolUse('edit-1', 'Edit', { file_path: 'a.ts' }),
        toolResult('edit-1', {}),
      ],
      createContext({ trustedBash: false }),
    )

    const last = output
      .filter(
        (message): message is AssistantMessage => message.type === 'assistant',
      )
      .at(-1)
    expect(last?.message.content[0]?.text).toContain('已完成修改。')
    expect(last?.message.content[0]?.text).toContain('未运行自动验证')
    expect(last?.message.content[0]?.text).toContain(
      '工具实际应用的工作区改动仍会保留',
    )
  })

  test('adds the boundary after non-text assistant content', async () => {
    queryImplementation = async () => {
      const message = createAssistantMessage('')
      message.message.content = [
        { type: 'image', source: { type: 'base64', data: 'AA==' } },
      ] as any
      return message
    }

    const { output } = await run(
      [
        createUserMessage('Implement the requested change.'),
        toolUse('edit-1', 'Edit', { file_path: 'a.ts' }),
        toolResult('edit-1', {}),
      ],
      createContext({ trustedBash: false }),
    )

    const last = output
      .filter(
        (message): message is AssistantMessage => message.type === 'assistant',
      )
      .at(-1)
    const text = last?.message.content.find(block => block.type === 'text')
    expect(text?.type === 'text' ? text.text : '').toContain(
      'Automated verification was not run',
    )
  })
})
