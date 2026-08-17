import { describe, expect, test } from 'bun:test'
import { handleMessageStream } from '#core/ai/llm/openai/stream'

function rawChunk(choice: Record<string, unknown>) {
  return {
    id: 'chatcmpl_test',
    model: 'mimo-v2.5-pro',
    created: 1,
    object: 'chat.completion.chunk',
    choices: [{ index: 0, finish_reason: null as string | null, ...choice }],
  }
}

function chunk(delta: Record<string, unknown>) {
  return rawChunk({ delta })
}

describe('OpenAI stream snapshot-field deduplication', () => {
  test('does not concatenate repeated snapshot metadata (type/id/role)', async () => {
    const repeated: unknown[] = []
    for (let i = 0; i < 10_000; i += 1) {
      repeated.push(
        chunk({
          type: 'function',
          id: 'call_abc123',
          role: 'assistant',
        }),
      )
    }
    repeated.push(
      chunk({
        type: 'function',
        content: 'hello',
      }),
    )

    async function* stream() {
      for (const item of repeated) yield item
    }

    const result = await handleMessageStream(stream() as any)
    const message = result.choices[0]!.message as unknown as Record<
      string,
      unknown
    >
    expect(message.type).toBe('function')
    expect(message.id).toBe('call_abc123')
    expect(message.role).toBe('assistant')
    expect(message.content).toBe('hello')
  })

  test('does not quadratically accumulate repeated full content deltas', async () => {
    const repeated: unknown[] = []
    const fullText = 'x'.repeat(1000)
    // Provider repeats the full accumulated content every chunk.
    for (let i = 0; i < 100; i += 1) {
      repeated.push(chunk({ content: fullText }))
    }

    async function* stream() {
      for (const item of repeated) yield item
    }

    const result = await handleMessageStream(stream() as any)
    const message = result.choices[0]!.message as { content: string }
    // endsWith check keeps a single copy instead of 100 concatenations.
    expect(message.content.length).toBe(1000)
  })

  test('accepts growing full-content snapshots and only forwards new text', async () => {
    const updates: Array<{ type: string; delta?: string }> = []

    async function* stream() {
      yield chunk({ content: 'Hel' })
      yield chunk({ content: 'Hello' })
      yield chunk({ content: 'Hello, world' })
    }

    const result = await handleMessageStream(stream() as any, undefined, {
      onAssistantStreamUpdate: event => {
        updates.push(event)
      },
    })
    const message = result.choices[0]!.message as { content: string }

    expect(message.content).toBe('Hello, world')
    expect(updates).toEqual([
      { type: 'start' },
      { type: 'text_delta', delta: 'Hel' },
      { type: 'text_delta', delta: 'lo' },
      { type: 'text_delta', delta: ', world' },
    ])
  })

  test('accepts growing reasoning snapshots and only forwards new thinking', async () => {
    const updates: Array<{ type: string; delta?: string }> = []

    async function* stream() {
      yield chunk({ reasoning_content: 'Inspect' })
      yield chunk({ reasoning_content: 'Inspect the request' })
      yield chunk({ content: 'Answer' })
    }

    const result = await handleMessageStream(stream() as any, undefined, {
      onAssistantStreamUpdate: event => {
        updates.push(event)
      },
    })
    const message = result.choices[0]!.message as unknown as Record<
      string,
      unknown
    >

    expect(message.reasoning_content).toBe('Inspect the request')
    expect(message.content).toBe('Answer')
    expect(updates).toEqual([
      { type: 'start' },
      { type: 'thinking_delta', delta: 'Inspect' },
      { type: 'thinking_delta', delta: ' the request' },
      { type: 'text_delta', delta: 'Answer' },
    ])
  })

  test('deduplicates repeated tool-call arguments (full-repeat provider)', async () => {
    const args = JSON.stringify({ command: 'ls -la', path: '/tmp' })
    const repeated: unknown[] = []
    for (let i = 0; i < 500; i += 1) {
      repeated.push(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'call_xyz',
              type: 'function',
              function: {
                name: 'Bash',
                arguments: args,
              },
            },
          ],
        }),
      )
    }

    async function* stream() {
      for (const item of repeated) yield item
    }

    const result = await handleMessageStream(stream() as any)
    const toolCalls = result.choices[0]!.message.tool_calls as Array<{
      function: { arguments: string }
    }>
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]!.function.arguments.length).toBe(args.length)
  })

  test('accepts growing full tool-argument snapshots', async () => {
    async function* stream() {
      yield chunk({
        tool_calls: [
          {
            index: 0,
            id: 'call_xyz',
            type: 'function',
            function: { name: 'Bash', arguments: '{"command":"' },
          },
        ],
      })
      yield chunk({
        tool_calls: [
          {
            index: 0,
            type: 'function',
            function: { arguments: '{"command":"pwd"}' },
          },
        ],
      })
    }

    const result = await handleMessageStream(stream() as any)
    const toolCalls = result.choices[0]!.message.tool_calls as Array<{
      function: { arguments: string }
    }>
    expect(toolCalls[0]!.function.arguments).toBe('{"command":"pwd"}')
  })

  test('still accumulates genuine incremental content deltas', async () => {
    async function* stream() {
      yield chunk({ content: 'Hel' })
      yield chunk({ content: 'lo, ' })
      yield chunk({ content: 'world' })
    }

    const result = await handleMessageStream(stream() as any)
    const message = result.choices[0]!.message as { content: string }
    expect(message.content).toBe('Hello, world')
  })

  test('accepts growing reasoning snapshots and only forwards new thinking', async () => {
    const updates: Array<{ type: string; delta?: string }> = []

    async function* stream() {
      yield chunk({ reasoning_content: 'Inspect' })
      yield chunk({ reasoning_content: 'Inspect the request' })
      yield chunk({ content: 'Answer' })
    }

    const result = await handleMessageStream(stream() as any, undefined, {
      onAssistantStreamUpdate: event => {
        updates.push(event)
      },
    })
    const message = result.choices[0]!.message as unknown as Record<
      string,
      unknown
    >

    expect(message.reasoning_content).toBe('Inspect the request')
    expect(message.content).toBe('Answer')
    expect(updates).toEqual([
      { type: 'start' },
      { type: 'thinking_delta', delta: 'Inspect' },
      { type: 'thinking_delta', delta: ' the request' },
      { type: 'text_delta', delta: 'Answer' },
    ])
  })

  test('still accumulates genuine incremental tool arguments', async () => {
    async function* stream() {
      yield chunk({
        tool_calls: [
          {
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'Bash', arguments: '{"com' },
          },
        ],
      })
      yield chunk({
        tool_calls: [
          {
            index: 0,
            type: 'function',
            function: { arguments: 'mand":"ls"}' },
          },
        ],
      })
    }

    const result = await handleMessageStream(stream() as any)
    const toolCalls = result.choices[0]!.message.tool_calls as Array<{
      function: { arguments: string }
    }>
    expect(toolCalls[0]!.function.arguments).toBe('{"command":"ls"}')
  })
})
