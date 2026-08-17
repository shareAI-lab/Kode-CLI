import { test, expect, describe } from 'bun:test'
import { ModelAdapterFactory } from '#core/ai/modelAdapterFactory'
import { ModelProfile } from '../../utils/config'
import { testModels, getResponsesAPIModels } from '../testAdapters'
import { processResponsesStream } from '#core/ai/adapters/responsesStreaming'
import { ReadableStream } from 'node:stream/web'

/** Responses API unit tests (params + streaming parity). */

describe('Responses API Tests', () => {
  describe('Responses API-specific functionality', () => {
    // Use a representative Responses API model for testing
    const testModel = getResponsesAPIModels(testModels)[0] || testModels[0]!

    test('handles Responses API request parameters correctly', () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)

      const unifiedParams = {
        messages: [{ role: 'user', content: 'test' }],
        systemPrompt: ['test system'],
        tools: [] as any[],
        maxTokens: 100,
        stream: true,
        temperature: 0.7,
      }

      const request = adapter.createRequest(unifiedParams)

      // Verify Responses API-specific structure
      expect(request).toHaveProperty('include')
      expect(request).toHaveProperty('max_output_tokens')
      expect(request).toHaveProperty('input')
      expect(request.stream).toBe(true)

      // Should NOT have Chat Completions fields
      expect(request).not.toHaveProperty('messages')
      expect(request).not.toHaveProperty('max_tokens')
      expect(request).not.toHaveProperty('max_completion_tokens')
    })

    test('parses Responses API response format correctly', async () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)

      const mockResponseData = {
        id: 'resp-test-123',
        object: 'response',
        created: Date.now(),
        model: testModel.modelName,
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'Mock response for Responses API',
              },
            ],
          },
        ],
        usage: {
          input_tokens: 15,
          output_tokens: 25,
          total_tokens: 40,
        },
      }

      const unifiedResponse = await adapter.parseResponse(mockResponseData)

      expect(unifiedResponse).toBeDefined()
      expect(unifiedResponse.id).toBe('resp-test-123')
      // Responses API returns content as array
      expect(Array.isArray(unifiedResponse.content)).toBe(true)
      expect(unifiedResponse.content.length).toBe(1)
      expect(unifiedResponse.content[0]).toHaveProperty('type', 'text')
      expect(unifiedResponse.content[0]).toHaveProperty(
        'text',
        'Mock response for Responses API',
      )
      expect(unifiedResponse.toolCalls).toBeDefined()
      expect(Array.isArray(unifiedResponse.toolCalls)).toBe(true)
      expect(unifiedResponse.toolCalls!.length).toBe(0)
    })

    test('parses nested output_text and refusal content parts', async () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)

      const unifiedResponse = await adapter.parseResponse({
        id: 'resp-nested-output-text',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'Visible answer' },
              { type: 'refusal', refusal: 'Cannot provide that detail' },
            ],
          },
        ],
        usage: {
          input_tokens: 3,
          output_tokens: 7,
          total_tokens: 10,
        },
      })

      const text = Array.isArray(unifiedResponse.content)
        ? unifiedResponse.content.map((item: any) => item.text).join('\n')
        : String(unifiedResponse.content)

      expect(text).toContain('Visible answer')
      expect(text).toContain('Cannot provide that detail')
      expect(unifiedResponse.responseId).toBe('resp-nested-output-text')
    })

    test('normalizes alternative non-streaming tool calls', async () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)

      const unifiedResponse = await adapter.parseResponse({
        id: 'resp-alt-tool',
        output: [
          {
            type: 'tool_call',
            id: 'call_alt',
            name: 'read_file',
            arguments: '{"path":"README.md"}',
          },
        ],
      })

      expect(unifiedResponse.toolCalls).toEqual([
        {
          id: 'call_alt',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: '{"path":"README.md"}',
          },
        },
      ])
    })

    test('rejects malformed non-streaming function call arguments', async () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)

      await expect(
        adapter.parseResponse({
          id: 'resp-bad-buffered-tool',
          output: [
            {
              type: 'function_call',
              id: 'fc_bad',
              call_id: 'call_bad',
              name: 'read_file',
              arguments: '{"path":',
            },
          ],
        }),
      ).rejects.toThrow('invalid JSON arguments')
    })

    test('includes reasoning and verbosity parameters when provided', () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)

      const unifiedParams = {
        messages: [{ role: 'user', content: 'Explain this code' }],
        systemPrompt: ['You are an expert'],
        maxTokens: 200,
        reasoningEffort: 'high' as const,
        verbosity: 'high' as const,
      }

      const request = adapter.createRequest(unifiedParams)

      expect(request.reasoning).toBeDefined()
      expect(request.reasoning.effort).toBe('high')
      expect(request.text).toBeDefined()
      expect(request.text.verbosity).toBe('high')
    })

    test('does not request reasoning summaries when the session disables them', () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)

      const request = adapter.createRequest({
        messages: [{ role: 'user', content: 'Answer directly' }],
        systemPrompt: ['You are a helpful assistant'],
        tools: [] as any[],
        maxTokens: 100,
        stream: true,
        reasoningEffort: 'high' as const,
        reasoning: {
          enable: false,
          effort: 'high' as const,
          summary: 'auto' as const,
        },
      })

      expect(request.reasoning).toBeUndefined()
      expect(request.include).toBeUndefined()
    })

    test('converts tool results to function_call_output format', () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)

      const unifiedParams = {
        messages: [
          { role: 'user', content: 'What is this file?' },
          {
            role: 'tool',
            tool_call_id: 'tool_123',
            content: 'This is a TypeScript file',
          },
          { role: 'user', content: 'Please read it' },
        ],
        systemPrompt: ['You are helpful'],
        maxTokens: 100,
      }

      const request = adapter.createRequest(unifiedParams)

      // Should have input array with function_call_output
      expect(request.input).toBeDefined()
      expect(Array.isArray(request.input)).toBe(true)

      // Should have function call result
      const hasFunctionCallOutput = request.input.some(
        (item: any) => item.type === 'function_call_output',
      )
      expect(hasFunctionCallOutput).toBe(true)
    })

    test('converts Anthropic user image blocks to input_image content', () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)

      const request = adapter.createRequest({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is in this image?' },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/jpeg',
                  data: 'Zm9v',
                },
              },
            ],
          },
        ],
        systemPrompt: ['You are helpful'],
        maxTokens: 100,
      })

      expect(request.input[0].content).toContainEqual({
        type: 'input_image',
        image_url: 'data:image/jpeg;base64,Zm9v',
      })
    })

    test('converts tool result images to function_call_output arrays', () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)

      const request = adapter.createRequest({
        messages: [
          {
            role: 'tool',
            tool_call_id: 'tool_123',
            content: [
              { type: 'text', text: 'Screenshot captured' },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/webp',
                  data: 'Zm9v',
                },
              },
            ],
          },
        ],
        systemPrompt: ['You are helpful'],
        maxTokens: 100,
      })

      const output = request.input.find(
        (item: any) => item.type === 'function_call_output',
      )?.output
      expect(Array.isArray(output)).toBe(true)
      expect(output).toContainEqual({
        type: 'input_text',
        text: 'Screenshot captured',
      })
      expect(output).toContainEqual({
        type: 'input_image',
        image_url: 'data:image/webp;base64,Zm9v',
      })
    })
  })

  describe('Responses API unique behaviors', () => {
    // Use a representative Responses API model for testing
    const testModel = getResponsesAPIModels(testModels)[0] || testModels[0]!

    test('joins multiple system prompts with double newlines', () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)

      const unifiedParams = {
        messages: [{ role: 'user', content: 'Hello' }],
        systemPrompt: ['You are a coding assistant', 'Always write clean code'],
        maxTokens: 50,
      }

      const request = adapter.createRequest(unifiedParams)

      // System prompts should be joined with double newlines
      expect(request.instructions).toBe(
        'You are a coding assistant\n\nAlways write clean code',
      )
    })

    test('respects stream flag for buffered requests', () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)

      const unifiedParams = {
        messages: [{ role: 'user', content: 'Hello' }],
        systemPrompt: ['You are helpful'],
        maxTokens: 100,
        stream: false,
      }

      const request = adapter.createRequest(unifiedParams)

      expect(request.stream).toBe(false)
    })

    test('streaming usage events expose unified token format', async () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)
      const encoder = new TextEncoder()
      const streamChunks = [
        'data: {"type":"response.created","response":{"id":"resp-stream-test"}}\n',
        'data: {"type":"response.output_text.delta","delta":"Hello"}\n',
        'data: {"type":"response.completed","response":{"id":"resp-stream-test","usage":{"input_tokens":12,"output_tokens":8,"total_tokens":20,"output_tokens_details":{"reasoning_tokens":3}}}}\n',
        'data: [DONE]\n',
      ]

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of streamChunks) {
            controller.enqueue(encoder.encode(chunk))
          }
          controller.close()
        },
      })

      const events: any[] = []
      if (!adapter.parseStreamingResponse) {
        throw new Error('Adapter does not support streaming')
      }
      for await (const event of adapter.parseStreamingResponse({
        body: stream,
        id: 'resp-stream-test',
      })) {
        events.push(event)
      }

      const usageEvent = events.find(event => event.type === 'usage')
      expect(usageEvent).toBeDefined()
      expect(usageEvent.usage).toMatchObject({
        input: 12,
        output: 8,
        total: 20,
        reasoning: 3,
      })

      async function* replayEvents(evts: any[]) {
        for (const evt of evts) {
          yield evt
        }
      }

      const { assistantMessage, rawResponse } = await processResponsesStream(
        replayEvents(events),
        Date.now(),
        'resp-stream-processed',
      )

      expect(assistantMessage.message.usage).toMatchObject({
        input_tokens: 12,
        output_tokens: 8,
        totalTokens: 20,
      })
      expect(rawResponse.id).toBe('resp-stream-test')
    })

    test('streams function call arguments done events as tool requests', async () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)
      const streamData = [
        'data: {"type":"response.created","response":{"id":"resp-tool-stream"}}\n\n',
        'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_123","type":"function_call","status":"in_progress","name":"read_file","arguments":"","call_id":"call_123"}}\n\n',
        'data: {"type":"response.function_call_arguments.delta","item_id":"fc_123","output_index":0,"delta":"{\\"path\\":"}\n\n',
        'data: {"type":"response.function_call_arguments.delta","item_id":"fc_123","output_index":0,"delta":"\\"README.md\\"}"}\n\n',
        'data: {"type":"response.function_call_arguments.done","item_id":"fc_123","output_index":0,"arguments":"{\\"path\\":\\"README.md\\"}"}\n\n',
        'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"fc_123","type":"function_call","status":"completed","name":"read_file","arguments":"{\\"path\\":\\"README.md\\"}","call_id":"call_123"}}\n\n',
        'data: {"type":"response.completed","response":{"id":"resp-tool-stream"}}\n\n',
        'data: [DONE]\n\n',
      ].join('')

      const events: any[] = []
      if (!adapter.parseStreamingResponse) {
        throw new Error('Adapter does not support streaming')
      }
      for await (const event of adapter.parseStreamingResponse(
        new Response(streamData),
      )) {
        events.push(event)
      }

      const toolRequests = events.filter(event => event.type === 'tool_request')
      expect(toolRequests).toEqual([
        {
          type: 'tool_request',
          tool: {
            id: 'call_123',
            name: 'read_file',
            input: '{"path":"README.md"}',
          },
        },
      ])

      async function* replayEvents(evts: any[]) {
        for (const evt of evts) {
          yield evt
        }
      }

      const { assistantMessage } = await processResponsesStream(
        replayEvents(events),
        Date.now(),
        'resp-tool-stream-fallback',
      )

      expect(assistantMessage.message.content).toContainEqual({
        type: 'tool_use',
        id: 'call_123',
        name: 'read_file',
        input: { path: 'README.md' },
      })
      expect(assistantMessage.responseId).toBe('resp-tool-stream')
    })

    test('rejects malformed streamed function call arguments', async () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)
      const streamData = [
        'data: {"type":"response.created","response":{"id":"resp-bad-tool"}}\n\n',
        'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_bad","type":"function_call","status":"in_progress","name":"read_file","arguments":"","call_id":"call_bad"}}\n\n',
        'data: {"type":"response.function_call_arguments.done","item_id":"fc_bad","output_index":0,"arguments":"{\\"path\\":"}\n\n',
        'data: [DONE]\n\n',
      ].join('')

      await expect(
        adapter.parseResponse(new Response(streamData)),
      ).rejects.toThrow('invalid JSON arguments')
    })

    test('streaming failure before assistant output rejects', async () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)
      const streamData = [
        'data: {"type":"response.created","response":{"id":"resp-failed-before-output"}}\n\n',
        'data: {"type":"response.failed","response":{"id":"resp-failed-before-output","status":"failed","error":{"message":"quota exceeded"}}}\n\n',
        'data: [DONE]\n\n',
      ].join('')

      await expect(
        adapter.parseResponse(new Response(streamData)),
      ).rejects.toThrow('quota exceeded')
    })

    test('streaming failure after assistant output marks partial response degraded', async () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)
      const streamData = [
        'data: {"type":"response.created","response":{"id":"resp-partial-failed"}}\n\n',
        'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
        'data: {"type":"response.failed","response":{"id":"resp-partial-failed","status":"failed","error":{"message":"socket reset"}}}\n\n',
        'data: [DONE]\n\n',
      ].join('')

      const events: any[] = []
      if (!adapter.parseStreamingResponse) {
        throw new Error('Adapter does not support streaming')
      }
      for await (const event of adapter.parseStreamingResponse(
        new Response(streamData),
      )) {
        events.push(event)
      }

      async function* replayEvents(evts: any[]) {
        for (const evt of evts) {
          yield evt
        }
      }

      const { assistantMessage, rawResponse } = await processResponsesStream(
        replayEvents(events),
        Date.now(),
        'resp-fallback',
      )

      expect(assistantMessage.responseId).toBe('resp-partial-failed')
      expect(assistantMessage.message.content).toEqual([
        { type: 'text', text: 'partial', citations: [] },
      ])
      expect(assistantMessage.message.stop_reason).toBe('max_tokens')
      expect(rawResponse).toMatchObject({
        id: 'resp-partial-failed',
        error: 'socket reset',
      })
    })
  })

  describe('Reasoning Support Tests', () => {
    const testModel = getResponsesAPIModels(testModels)[0] || testModels[0]!

    test('includes reasoning and verbosity parameters when provided', () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)

      const unifiedParams = {
        messages: [{ role: 'user', content: 'Solve this complex problem' }],
        systemPrompt: ['You are a helpful assistant'],
        tools: [] as any[],
        maxTokens: 100,
        stream: true,
        reasoningEffort: 'high' as const,
        verbosity: 'high' as const,
      }

      const request = adapter.createRequest(unifiedParams)

      // Verify reasoning configuration
      expect(request).toHaveProperty('reasoning')
      expect(request.reasoning).toBeDefined()
      expect(request.reasoning.effort).toBe('high')
      expect(request.reasoning.summary).toBe('auto')

      // Verify reasoning content inclusion
      expect(request).toHaveProperty('include')
      expect(request.include).toContain('reasoning.encrypted_content')

      // Verify verbosity configuration
      expect(request).toHaveProperty('text')
      expect(request.text.verbosity).toBe('high')
    })

    test('keeps streamed reasoning separate before emitting final text', async () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)
      const updates: Array<{ type: string; delta?: string }> = []
      const streamData = [
        'data: {"type":"response.created","response":{"id":"resp-thinking-then-text"}}\n\n',
        'data: {"type":"response.reasoning_summary_part.added","summary_index":0}\n\n',
        'data: {"type":"response.reasoning_summary_text.delta","delta":"Plan the answer"}\n\n',
        'data: {"type":"response.output_text.delta","delta":"Final answer"}\n\n',
        'data: {"type":"response.completed","response":{"id":"resp-thinking-then-text"}}\n\n',
        'data: [DONE]\n\n',
      ].join('')

      const response = await adapter.parseResponse(new Response(streamData), {
        onAssistantStreamUpdate: event => {
          updates.push(event)
        },
      })

      expect(response.content).toEqual([
        {
          type: 'thinking',
          thinking: 'Plan the answer',
          signature: '',
        },
        { type: 'text', text: 'Final answer', citations: [] },
      ])
      expect(updates).toEqual([
        { type: 'start' },
        { type: 'thinking_delta', delta: 'Plan the answer' },
        { type: 'text_delta', delta: 'Final answer' },
      ])
    })

    test('preserves a completed reasoning-only response for turn recovery', async () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)
      const streamData = [
        'data: {"type":"response.created","response":{"id":"resp-thinking-only"}}\n\n',
        'data: {"type":"response.reasoning_text.delta","delta":"Need one more step"}\n\n',
        'data: {"type":"response.completed","response":{"id":"resp-thinking-only"}}\n\n',
        'data: [DONE]\n\n',
      ].join('')

      const response = await adapter.parseResponse(new Response(streamData))

      expect(response.content).toEqual([
        {
          type: 'thinking',
          thinking: 'Need one more step',
          signature: '',
        },
      ])
    })

    test('processes real GPT-5 reasoning stream with reasoning items and text deltas', async () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)

      // Mock real reasoning stream based on actual GPT-5 API behavior
      const reasoningStreamData = [
        'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"rs_123","type":"reasoning","summary":[]}}\n\n',
        'data: {"type":"response.output_item.done","output_index":0,"item":{"id":"rs_123","type":"reasoning","summary":[]}}\n\n',
        'data: {"type":"response.output_item.added","output_index":1,"item":{"id":"msg_123","type":"message","status":"in_progress","content":[],"role":"assistant"}}\n\n',
        'data: {"type":"response.content_part.added","item_id":"msg_123","output_index":1,"content_index":0,"part":{"type":"output_text","text":""}}\n\n',
        'data: {"type":"response.output_text.delta","item_id":"msg_123","output_index":1,"content_index":0,"delta":"Let me think step by step"}\n\n',
        'data: {"type":"response.output_text.delta","item_id":"msg_123","output_index":1,"content_index":0,"delta":"\\n\\nFirst, I need to analyze the problem"}\n\n',
        'data: {"type":"response.output_text.delta","item_id":"msg_123","output_index":1,"content_index":0,"delta":"\\n\\nThe solution is:"}\n\n',
        'data: {"type":"response.output_text.delta","item_id":"msg_123","output_index":1,"content_index":0,"delta":" $0.05"}\n\n',
        'data: {"type":"response.completed"}\n\n',
        'data: [DONE]\n\n',
      ].join('')

      const response = new Response(reasoningStreamData)
      const events = []

      // Collect all streaming events
      if (!adapter.parseStreamingResponse) {
        throw new Error('Adapter does not support streaming')
      }
      for await (const event of adapter.parseStreamingResponse(response)) {
        events.push(event)
      }

      // Verify reasoning content is processed as regular text deltas
      const textDeltas = events.filter(e => e.type === 'text_delta')
      expect(textDeltas.length).toBeGreaterThan(0)

      // Should include the reasoning content mixed with answer
      const fullContent = textDeltas.map(e => e.delta).join('')
      expect(fullContent).toContain('Let me think step by step')
      expect(fullContent).toContain('First, I need to analyze the problem')
      expect(fullContent).toContain('The solution is:')
      expect(fullContent).toContain('$0.05')

      // Should be properly formatted as continuous reasoning
      const expectedReasoningPattern = new RegExp(
        'Let me think step by step' +
          '\n\n' +
          'First, I need to analyze the problem' +
          '\n\n' +
          'The solution is: \\$0\\.05',
      )
      expect(fullContent).toMatch(expectedReasoningPattern)
    })

    test('processes non-streaming response with real GPT-5 reasoning structure', async () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)

      // Mock non-streaming response based on real GPT-5 API structure
      // In real API, reasoning content appears directly in message text
      const mockResponse = {
        id: 'resp-test-reasoning',
        output_text:
          '$0.05\n\nReason: Let the ball cost x. Then the bat costs x + 1.00. So x + (x + 1.00) = 1.10 ⇒ 2x = 0.10 ⇒ x = 0.05. The intuitive $0.10 would make the total $1.20, not $1.10.',
        usage: {
          input_tokens: 5062,
          output_tokens: 340,
          total_tokens: 5402,
          output_tokens_details: {
            reasoning_tokens: 256, // Real reasoning token count
          },
        },
      }

      const result = await adapter.parseResponse(mockResponse)

      // Verify reasoning content is extracted and formatted with think blocks
      expect(result.content).toBeDefined()
      const contentText = Array.isArray(result.content)
        ? result.content.map(c => c.text).join('')
        : result.content

      // Should contain the reasoning and answer content
      expect(contentText).toContain('$0.05') // Answer part
      expect(contentText).toContain('Reason: Let the ball cost x') // Reasoning part

      // Verify reasoning tokens are captured correctly
      expect(result.usage.reasoningTokens).toBe(256)
    })

    test('handles response without reasoning content gracefully', async () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)

      // Mock response without reasoning
      const mockResponse = {
        id: 'resp-no-reasoning',
        output_text: 'Simple answer without reasoning.',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
        },
      }

      const result = await adapter.parseResponse(mockResponse)

      // Should work normally without think blocks
      expect(result.content).toBeDefined()
      const contentText = Array.isArray(result.content)
        ? result.content.map(c => c.text).join('')
        : result.content

      expect(contentText).toBe('Simple answer without reasoning.')
      // Should not have think blocks in simple responses

      // Should not have reasoning tokens
      expect(result.usage.reasoningTokens).toBeUndefined()
    })

    test('handles reasoning effort parameter validation', () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)

      // Test different reasoning effort levels
      const effortLevels = ['minimal', 'low', 'medium', 'high'] as const

      effortLevels.forEach(effort => {
        const request = adapter.createRequest({
          messages: [{ role: 'user', content: 'test' }],
          systemPrompt: [],
          tools: [],
          maxTokens: 100,
          reasoningEffort: effort,
        })

        expect(request.reasoning.effort).toBe(effort)
        expect(request.include).toContain('reasoning.encrypted_content')
      })
    })
  })
})
