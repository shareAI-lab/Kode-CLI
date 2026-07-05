import { describe, expect, test } from 'bun:test'
import {
  handleMessageStream,
  isOpenAIStreamDegradedResponse,
} from '#core/ai/llm/openai/stream'
import { createStreamProcessor } from '#core/ai/openai/stream'

function chunk(delta: Record<string, unknown>) {
  return {
    id: 'chatcmpl_test',
    model: 'gpt-4',
    created: 1,
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta, finish_reason: null }],
  }
}

function sseBody(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${line}\n`))
      }
      controller.close()
    },
  })
}

describe('OpenAI stream cancellation', () => {
  test('rejects when signal is aborted before reading stream chunks', async () => {
    const controller = new AbortController()
    controller.abort()

    async function* stream() {
      yield chunk({ content: 'late' })
    }

    await expect(
      handleMessageStream(stream() as any, controller.signal),
    ).rejects.toThrow('Request was cancelled')
  })

  test('does not return a partial response when signal aborts after a chunk', async () => {
    const controller = new AbortController()

    async function* stream() {
      yield chunk({ content: 'partial' })
      controller.abort()
    }

    await expect(
      handleMessageStream(stream() as any, controller.signal),
    ).rejects.toThrow('Request was cancelled')
  })
})

describe('OpenAI stream degradation', () => {
  test('rejects read failures before the first usable assistant token', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('socket closed'))
      },
    })

    await expect(
      handleMessageStream(createStreamProcessor(body as any) as any, undefined),
    ).rejects.toThrow('socket closed')
  })

  test('rejects malformed-only SSE instead of returning no content', async () => {
    const body = sseBody(['data: {bad json}'])

    await expect(
      handleMessageStream(createStreamProcessor(body as any) as any, undefined),
    ).rejects.toThrow('malformed JSON')
  })

  test('rejects SSE error payloads instead of returning no content', async () => {
    const body = sseBody(['data: {"error":{"message":"provider unavailable"}}'])

    await expect(
      handleMessageStream(createStreamProcessor(body as any) as any, undefined),
    ).rejects.toThrow('provider unavailable')
  })

  test('marks malformed SSE chunks as degraded without blocking partial output', async () => {
    const validChunk = JSON.stringify(chunk({ content: 'partial' }))
    const body = sseBody([`data: ${validChunk}`, 'data: {bad json}'])

    const result = await handleMessageStream(
      createStreamProcessor(body as any) as any,
      undefined,
    )

    expect(result.choices[0]?.message.content).toBe('partial')
    expect(result.choices[0]?.finish_reason).toBe('length')
    expect(isOpenAIStreamDegradedResponse(result)).toBe(true)
  })

  test('marks stream read failures as degraded without blocking partial output', async () => {
    const encoder = new TextEncoder()
    const validChunk = JSON.stringify(chunk({ content: 'partial' }))
    let sent = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true
          controller.enqueue(encoder.encode(`data: ${validChunk}\n`))
          return
        }
        controller.error(new Error('socket closed'))
      },
    })

    const result = await handleMessageStream(
      createStreamProcessor(body as any) as any,
      undefined,
    )

    expect(result.choices[0]?.message.content).toBe('partial')
    expect(result.choices[0]?.finish_reason).toBe('length')
    expect(isOpenAIStreamDegradedResponse(result)).toBe(true)
  })
})
