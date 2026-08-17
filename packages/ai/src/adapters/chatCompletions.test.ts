import { describe, expect, test } from 'bun:test'
import type { StreamingEvent } from './openaiAdapter'
import { ChatCompletionsAdapter } from './chatCompletions'
import { getModelCapabilities } from '../internal/modelCapabilities'
import type { AiModelProfileLike } from '../internal/runtimeConfig'

function makeAdapter(): ChatCompletionsAdapter {
  const capabilities = getModelCapabilities('gpt-4o')
  const profile: AiModelProfileLike = {
    modelName: 'gpt-4o',
    name: 'gpt-4o',
    provider: 'openai',
    baseURL: 'https://api.openai.com/v1',
  }
  return new ChatCompletionsAdapter(capabilities, profile)
}

function sseStream(chunks: unknown[]): ReadableStream {
  const encoder = new TextEncoder()
  const body = chunks
    .map(chunk => `data: ${JSON.stringify(chunk)}\n\n`)
    .join('')
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body))
      controller.close()
    },
  })
}

function chatChunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): Record<string, unknown> {
  return {
    id: 'chatcmpl_test',
    model: 'gpt-4o',
    created: 1,
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

async function collectEvents(
  adapter: ChatCompletionsAdapter,
  chunks: unknown[],
): Promise<StreamingEvent[]> {
  const events: StreamingEvent[] = []
  for await (const event of adapter.parseStreamingResponse({
    id: 'resp_test',
    body: sseStream(chunks),
  })) {
    events.push(event)
  }
  return events
}

describe('ChatCompletionsAdapter snapshot-field deduplication', () => {
  test('only forwards the new portion of growing content snapshots', async () => {
    const events = await collectEvents(makeAdapter(), [
      chatChunk({ content: 'Hel' }),
      chatChunk({ content: 'Hello' }),
      chatChunk({ content: 'Hello, world' }),
      chatChunk({}, 'stop'),
    ])

    const deltas = events
      .filter(event => event.type === 'text_delta')
      .map(event => (event as { delta: string }).delta)
    expect(deltas).toEqual(['Hel', 'lo', ', world'])
  })

  test('does not concatenate repeated full content snapshots', async () => {
    const fullText = 'x'.repeat(500)
    const chunks: unknown[] = []
    for (let i = 0; i < 50; i += 1) {
      chunks.push(chatChunk({ content: fullText }))
    }
    chunks.push(chatChunk({}, 'stop'))

    const events = await collectEvents(makeAdapter(), chunks)
    const deltas = events
      .filter(event => event.type === 'text_delta')
      .map(event => (event as { delta: string }).delta)
    expect(deltas).toEqual([fullText])
  })

  test('deduplicates repeated full tool-call argument snapshots', async () => {
    const args = JSON.stringify({ command: 'ls -la', path: '/tmp' })
    const chunks: unknown[] = []
    for (let i = 0; i < 100; i += 1) {
      chunks.push(
        chatChunk({
          tool_calls: [
            {
              index: 0,
              id: 'call_xyz',
              type: 'function',
              function: { name: 'Bash', arguments: args },
            },
          ],
        }),
      )
    }
    chunks.push(chatChunk({}, 'tool_calls'))

    const events = await collectEvents(makeAdapter(), chunks)
    const tools = events
      .filter(event => event.type === 'tool_request')
      .map(event => (event as { tool: { input: string } }).tool)
    expect(tools).toHaveLength(1)
    expect(tools[0]!.input).toBe(args)
  })

  test('still accumulates genuine incremental content deltas', async () => {
    const events = await collectEvents(makeAdapter(), [
      chatChunk({ content: 'Hel' }),
      chatChunk({ content: 'lo, ' }),
      chatChunk({ content: 'world' }),
      chatChunk({}, 'stop'),
    ])

    const deltas = events
      .filter(event => event.type === 'text_delta')
      .map(event => (event as { delta: string }).delta)
    expect(deltas.join('')).toBe('Hello, world')
  })

  test('still accumulates genuine incremental tool arguments', async () => {
    const chunks: unknown[] = [
      chatChunk({
        tool_calls: [
          {
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'Bash', arguments: '{"com' },
          },
        ],
      }),
      chatChunk({
        tool_calls: [
          {
            index: 0,
            type: 'function',
            function: { arguments: 'mand":"ls"}' },
          },
        ],
      }),
      chatChunk({}, 'tool_calls'),
    ]

    const events = await collectEvents(makeAdapter(), chunks)
    const tools = events
      .filter(event => event.type === 'tool_request')
      .map(event => (event as { tool: { input: string } }).tool)
    expect(tools[0]!.input).toBe('{"command":"ls"}')
  })
})
