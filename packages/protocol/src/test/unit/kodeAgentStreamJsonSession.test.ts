import { describe, expect, test } from 'bun:test'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'

import { KodeAgentStructuredStdio } from '#protocol/utils/kodeAgentStructuredStdio'
import { runKodeAgentStreamJsonSession } from '#protocol/utils/kodeAgentStreamJsonSession'

type TestMessage = {
  type: string
  uuid: string
  message?: { role: string; content: unknown }
  isApiErrorMessage?: boolean
}

type TestToolUseContext = { abortController: AbortController }

function makeLineReader(
  rl: ReturnType<typeof createInterface>,
): () => Promise<string> {
  const queue: string[] = []
  let resolveNext: ((line: string) => void) | null = null

  rl.on('line', line => {
    if (resolveNext) {
      const resolve = resolveNext
      resolveNext = null
      resolve(line)
      return
    }
    queue.push(line)
  })

  return async () => {
    if (queue.length > 0) return queue.shift()!
    return await new Promise<string>(resolve => {
      resolveNext = resolve
    })
  }
}

describe('stream-json session structured output', () => {
  test('parses fenced JSON from the assistant text into structured_output', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const rlOut = createInterface({ input: stdout })
    const nextLine = makeLineReader(rlOut)

    const structured = new KodeAgentStructuredStdio(stdin, stdout)
    structured.start()

    const query = async function* (
      _messages: TestMessage[],
      _systemPrompt: string[],
      _context: { [k: string]: string },
      _canUseTool: unknown,
      _toolUseContext: TestToolUseContext,
    ): AsyncGenerator<TestMessage, void> {
      yield {
        type: 'assistant',
        uuid: 'assistant-1',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: '```json\n{"summary": "verified", "count": 3}\n```',
            },
          ],
        },
      }
    }

    const canUseTool = async () => ({ result: true })

    const sessionPromise = runKodeAgentStreamJsonSession<
      TestMessage,
      TestToolUseContext
    >({
      structured,
      query,
      makeUserMessage: content => ({
        type: 'user',
        uuid: crypto.randomUUID(),
        message: { role: 'user', content },
      }),
      writeSdkLine: obj => {
        stdout.write(JSON.stringify(obj) + '\n')
      },
      sessionId: 'sess_test',
      systemPrompt: [],
      context: {},
      canUseTool,
      toolUseContextBase: {},
      replayUserMessages: false,
      getTotalCostUsd: () => 0,
      jsonSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          count: { type: 'number' },
        },
        required: ['summary', 'count'],
        additionalProperties: false,
      },
    })

    stdin.write(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'hi' },
      }) + '\n',
    )

    const assistant = JSON.parse(await nextLine())
    expect(assistant.type).toBe('assistant')

    const result = JSON.parse(await nextLine())
    expect(result.type).toBe('result')
    expect(result.is_error).toBe(false)
    expect(result.subtype).toBe('success')
    expect(result.structured_output).toEqual({ summary: 'verified', count: 3 })

    stdin.end()
    await sessionPromise
    rlOut.close()
    stdout.end()
  })

  test('keeps a plain (unfenced) JSON object as structured output', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const rlOut = createInterface({ input: stdout })
    const nextLine = makeLineReader(rlOut)

    const structured = new KodeAgentStructuredStdio(stdin, stdout)
    structured.start()

    const query = async function* (
      _messages: TestMessage[],
      _systemPrompt: string[],
      _context: { [k: string]: string },
      _canUseTool: unknown,
      _toolUseContext: TestToolUseContext,
    ): AsyncGenerator<TestMessage, void> {
      yield {
        type: 'assistant',
        uuid: 'assistant-2',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: '{"summary": "plain", "count": 1}',
            },
          ],
        },
      }
    }

    const sessionPromise = runKodeAgentStreamJsonSession<
      TestMessage,
      TestToolUseContext
    >({
      structured,
      query,
      makeUserMessage: content => ({
        type: 'user',
        uuid: crypto.randomUUID(),
        message: { role: 'user', content },
      }),
      writeSdkLine: obj => {
        stdout.write(JSON.stringify(obj) + '\n')
      },
      sessionId: 'sess_test',
      systemPrompt: [],
      context: {},
      canUseTool: async () => ({ result: true }),
      toolUseContextBase: {},
      replayUserMessages: false,
      getTotalCostUsd: () => 0,
      jsonSchema: {
        type: 'object',
        properties: { summary: { type: 'string' }, count: { type: 'number' } },
        required: ['summary', 'count'],
        additionalProperties: false,
      },
    })

    stdin.write(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'hi' },
      }) + '\n',
    )

    await nextLine() // assistant
    const result = JSON.parse(await nextLine())
    expect(result.type).toBe('result')
    expect(result.is_error).toBe(false)
    expect(result.structured_output).toEqual({ summary: 'plain', count: 1 })

    stdin.end()
    await sessionPromise
    rlOut.close()
    stdout.end()
  })
})
