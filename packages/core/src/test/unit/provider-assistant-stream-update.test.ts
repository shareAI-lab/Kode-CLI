import { describe, expect, test } from 'bun:test'
import type { AssistantStreamUpdate } from '@kode/tool-interface/Tool'
import { ResponsesAPIAdapter } from '#core/ai/adapters/responsesAPI'
import { createAnthropicStreamingMessage } from '#core/ai/llm/anthropic/streaming'
import { handleMessageStream } from '#core/ai/llm/openai/stream'

function callbackThatThrows(updates: AssistantStreamUpdate[]) {
  return (event: AssistantStreamUpdate) => {
    updates.push(event)
    throw new Error('consumer callback failed')
  }
}

function callbackThatRejects(updates: AssistantStreamUpdate[]) {
  return async (event: AssistantStreamUpdate) => {
    updates.push(event)
    throw new Error('async consumer callback failed')
  }
}

function createLegacyOpenAIStream(text: string) {
  return (async function* () {
    const base = {
      id: 'chatcmpl_test',
      model: 'gpt-4',
      created: 1,
      object: 'chat.completion.chunk',
    }

    yield {
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant' },
          finish_reason: null as string | null,
        },
      ],
    }
    yield {
      ...base,
      choices: [
        {
          index: 0,
          delta: { content: text },
          finish_reason: null as string | null,
        },
      ],
    }
    yield {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    }
  })()
}

describe('provider assistant stream updates', () => {
  test('Anthropic preserves raw events and isolates typed callback failures', async () => {
    const rawEventTypes: string[] = []
    const updates: AssistantStreamUpdate[] = []
    const rawEvents = [
      {
        type: 'message_start',
        message: {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [] as any[],
          stop_reason: null as string | null,
          stop_sequence: null as string | null,
          usage: { input_tokens: 2, output_tokens: 0 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Inspect first.' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'signed-thinking' },
      },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'Hello' },
      },
      {
        type: 'message_delta',
        delta: {
          stop_reason: 'end_turn',
          stop_sequence: null as string | null,
        },
        usage: { output_tokens: 1 },
      },
      { type: 'message_stop' },
    ]
    const anthropic = {
      beta: {
        messages: {
          create: async () =>
            (async function* () {
              for (const event of rawEvents) yield event
            })(),
        },
      },
    }

    const response = await createAnthropicStreamingMessage(
      anthropic as any,
      {} as any,
      new AbortController().signal,
      {
        onStreamEvent: event => {
          rawEventTypes.push((event as { type: string }).type)
        },
        onAssistantStreamUpdate: callbackThatThrows(updates),
        agentId: 'agent-anthropic',
        requestId: 'request-anthropic',
      },
    )

    expect(response.content).toEqual([
      {
        type: 'thinking',
        thinking: 'Inspect first.',
        signature: 'signed-thinking',
      },
      { type: 'text', text: 'Hello' },
    ])
    expect(rawEventTypes).toEqual(rawEvents.map(event => event.type))
    expect(updates).toEqual([
      {
        type: 'start',
        agentId: 'agent-anthropic',
        requestId: 'request-anthropic',
      },
      {
        type: 'thinking_delta',
        delta: 'Inspect first.',
        agentId: 'agent-anthropic',
        requestId: 'request-anthropic',
      },
      {
        type: 'text_delta',
        delta: 'Hello',
        agentId: 'agent-anthropic',
        requestId: 'request-anthropic',
      },
    ])
  })

  test('legacy OpenAI emits one start per stream attempt before text', async () => {
    const updates: AssistantStreamUpdate[] = []
    const options = {
      onAssistantStreamUpdate: callbackThatThrows(updates),
      agentId: 'agent-openai',
      requestId: 'request-openai',
    }

    const first = await handleMessageStream(
      createLegacyOpenAIStream('stale') as any,
      undefined,
      options,
    )
    const second = await handleMessageStream(
      createLegacyOpenAIStream('fresh') as any,
      undefined,
      options,
    )

    expect(first.choices[0]?.message.content).toBe('stale')
    expect(second.choices[0]?.message.content).toBe('fresh')
    expect(updates).toEqual([
      {
        type: 'start',
        agentId: 'agent-openai',
        requestId: 'request-openai',
      },
      {
        type: 'text_delta',
        delta: 'stale',
        agentId: 'agent-openai',
        requestId: 'request-openai',
      },
      {
        type: 'start',
        agentId: 'agent-openai',
        requestId: 'request-openai',
      },
      {
        type: 'text_delta',
        delta: 'fresh',
        agentId: 'agent-openai',
        requestId: 'request-openai',
      },
    ])
  })

  test('Responses adapter emits typed updates without affecting parsing', async () => {
    const updates: AssistantStreamUpdate[] = []
    const adapter = new ResponsesAPIAdapter(
      {} as any,
      { modelName: 'gpt-5' } as any,
    )
    const streamData = [
      'data: {"type":"response.created","response":{"id":"resp-test"}}\n\n',
      'data: {"type":"response.reasoning_summary_part.added","summary_index":0}\n\n',
      'data: {"type":"response.reasoning_summary_text.delta","delta":"Inspect the request first."}\n\n',
      'data: {"type":"response.reasoning_summary_text.done","text":"Inspect the request first."}\n\n',
      'data: {"type":"response.output_text.delta","delta":"Hello"}\n\n',
      'data: {"type":"response.output_text.delta","delta":" world"}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp-test"}}\n\n',
      'data: [DONE]\n\n',
    ].join('')

    const response = await adapter.parseResponse(new Response(streamData), {
      onAssistantStreamUpdate: callbackThatRejects(updates),
      agentId: 'agent-responses',
      requestId: 'request-responses',
    })

    expect(response.content).toEqual([
      {
        type: 'thinking',
        thinking: 'Inspect the request first.',
        signature: '',
      },
      { type: 'text', text: 'Hello world', citations: [] },
    ])
    expect(updates).toEqual([
      {
        type: 'start',
        agentId: 'agent-responses',
        requestId: 'request-responses',
      },
      {
        type: 'thinking_delta',
        delta: 'Inspect the request first.',
        agentId: 'agent-responses',
        requestId: 'request-responses',
      },
      {
        type: 'text_delta',
        delta: 'Hello',
        agentId: 'agent-responses',
        requestId: 'request-responses',
      },
      {
        type: 'text_delta',
        delta: ' world',
        agentId: 'agent-responses',
        requestId: 'request-responses',
      },
    ])
  })

  test('Responses adapter recovers provider reasoning from a completion event', async () => {
    const updates: AssistantStreamUpdate[] = []
    const adapter = new ResponsesAPIAdapter(
      {} as any,
      { modelName: 'gpt-5' } as any,
    )
    const streamData = [
      'data: {"type":"response.created","response":{"id":"resp-done"}}\n\n',
      'data: {"type":"response.reasoning_summary_part.added","item_id":"rs_1","summary_index":0}\n\n',
      'data: {"type":"response.reasoning_summary_text.done","item_id":"rs_1","summary_index":0,"text":"Recovered summary."}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp-done"}}\n\n',
      'data: [DONE]\n\n',
    ].join('')

    const response = await adapter.parseResponse(new Response(streamData), {
      onAssistantStreamUpdate: callbackThatThrows(updates),
    })

    expect(response.content).toEqual([
      {
        type: 'thinking',
        thinking: 'Recovered summary.',
        signature: '',
      },
    ])
    expect(updates).toEqual([
      { type: 'start' },
      { type: 'thinking_delta', delta: 'Recovered summary.' },
    ])
  })
})
