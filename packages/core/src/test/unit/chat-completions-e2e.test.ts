import { test, expect, describe } from 'bun:test'
import { ModelAdapterFactory } from '#core/ai/modelAdapterFactory'
import { getModelCapabilities } from '../../constants/modelCapabilities'
import { testModels, getChatCompletionsModels } from '../testAdapters'
import { buildAssistantMessageFromUnifiedResponse } from '#core/ai/llm/openai/unifiedResponse'

/**
 * Chat Completions API Unit Tests
 *
 * This test file contains Chat Completions API-specific functionality tests.
 * These tests validate Chat Completions-specific features and behaviors
 * that are not covered by the general adapter tests.
 */

describe('Chat Completions API Tests', () => {
  describe('Chat Completions API-specific functionality', () => {
    // Use a representative Chat Completions model for testing
    const testModel = getChatCompletionsModels(testModels)[0] || testModels[0]!

    test('handles Chat Completions request parameters correctly', () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)
      const capabilities = getModelCapabilities(testModel.modelName)

      const unifiedParams = {
        messages: [
          { role: 'user', content: 'Write a simple JavaScript function' },
        ],
        systemPrompt: ['You are a helpful coding assistant.'],
        tools: [] as any[],
        maxTokens: 100,
        stream: capabilities.streaming.supported,
        temperature: 0.7,
      }

      const request = adapter.createRequest(unifiedParams)

      // Verify Chat Completions-specific structure
      expect(request).toHaveProperty('model', testModel.modelName)
      expect(request).toHaveProperty('messages')
      expect(request.messages).toBeInstanceOf(Array)
      expect(request.messages.some((msg: any) => msg.role === 'user')).toBe(
        true,
      )
      expect(request.messages.some((msg: any) => msg.role === 'system')).toBe(
        true,
      )

      // Should use max_tokens or max_completion_tokens
      const hasMaxTokens =
        request.hasOwnProperty('max_tokens') ||
        request.hasOwnProperty('max_completion_tokens')
      expect(hasMaxTokens).toBe(true)

      // Should NOT have Responses API fields
      expect(request).not.toHaveProperty('include')
      expect(request).not.toHaveProperty('max_output_tokens')
      expect(request).not.toHaveProperty('reasoning')
    })

    test('parses Chat Completions response format correctly', async () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)

      const mockResponseData = {
        id: 'chatcmpl-test-123',
        object: 'chat.completion',
        created: Date.now(),
        model: testModel.modelName,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'function hello() { return "Hello World"; }',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 25,
          completion_tokens: 15,
          total_tokens: 40,
        },
      }

      const unifiedResponse = await adapter.parseResponse(mockResponseData)

      expect(unifiedResponse).toBeDefined()
      expect(unifiedResponse.id).toBe('chatcmpl-test-123')
      expect(unifiedResponse.content).toBe(
        'function hello() { return "Hello World"; }',
      )
      expect(unifiedResponse.toolCalls).toBeDefined()
      expect(Array.isArray(unifiedResponse.toolCalls)).toBe(true)
      expect(unifiedResponse.toolCalls!.length).toBe(0)
    })

    test('handles Chat Completions tool results correctly', () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)

      const unifiedParams = {
        messages: [
          { role: 'user', content: 'What is this file?' },
          {
            role: 'tool',
            tool_call_id: 'tool_123',
            content: 'This is a TypeScript file',
          },
          { role: 'assistant', content: 'I need to check the file first' },
          { role: 'user', content: 'Please read it' },
        ],
        systemPrompt: ['You are helpful'],
        maxTokens: 100,
      }

      const request = adapter.createRequest(unifiedParams)

      // Should maintain message structure for Chat Completions
      expect(request.messages).toBeDefined()
      expect(Array.isArray(request.messages)).toBe(true)
      expect(request.messages.length).toBeGreaterThan(0)

      // Should have tool result, assistant message, and user message
      const hasToolMessage = request.messages.some(
        (msg: any) => msg.role === 'tool',
      )
      const hasUserMessage = request.messages.some(
        (msg: any) => msg.role === 'user',
      )
      const hasAssistantMessage = request.messages.some(
        (msg: any) => msg.role === 'assistant',
      )

      expect(hasToolMessage).toBe(true)
      expect(hasUserMessage).toBe(true)
      expect(hasAssistantMessage).toBe(true)
    })

    test('preserves tool result images in adjacent user vision message', () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)

      const request = adapter.createRequest({
        messages: [
          {
            role: 'tool',
            tool_call_id: 'tool_123',
            content: [
              { type: 'text', text: 'Screenshot captured' },
              {
                type: 'image_url',
                image_url: { url: 'data:image/gif;base64,Zm9v' },
              },
            ],
          },
        ],
        systemPrompt: ['You are helpful'],
        maxTokens: 100,
      })

      const toolIndex = request.messages.findIndex(
        (msg: any) => msg.role === 'tool',
      )
      expect(toolIndex).toBeGreaterThanOrEqual(0)
      expect(request.messages[toolIndex].content).toBe('Screenshot captured')

      const imageMessage = request.messages[toolIndex + 1]
      expect(imageMessage.role).toBe('user')
      expect(imageMessage.content).toContainEqual({
        type: 'image_url',
        image_url: { url: 'data:image/gif;base64,Zm9v' },
      })
    })

    test('merges fragmented streaming tool calls into one executable block', async () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)
      const streamData = [
        'data: {"id":"chatcmpl-tool-stream","choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_123","type":"function","function":{"name":"Bash","arguments":"{\\"command\\":"}}]}}]}\n\n',
        'data: {"id":"chatcmpl-tool-stream","choices":[{"delta":{"tool_calls":[{"index":0,"type":"function","function":{"name":"Bash","arguments":"\\"pwd\\""}}]}}]}\n\n',
        'data: {"id":"chatcmpl-tool-stream","choices":[{"delta":{"tool_calls":[{"index":0,"type":"function","function":{"name":"Bash","arguments":"}"}}]}}]}\n\n',
        'data: [DONE]\n\n',
      ].join('')

      const unifiedResponse = await adapter.parseResponse(
        new Response(streamData),
      )
      const assistantMessage = buildAssistantMessageFromUnifiedResponse(
        unifiedResponse,
        Date.now(),
      )

      expect(unifiedResponse.toolCalls).toEqual([])
      expect(unifiedResponse.content).toEqual([
        {
          type: 'tool_use',
          id: 'call_123',
          name: 'Bash',
          input: { command: 'pwd' },
        },
      ])
      expect(
        assistantMessage.message.content.filter(
          block => block.type === 'tool_use',
        ),
      ).toHaveLength(1)
    })

    test('accepts growing tool-argument snapshots from compatible providers', async () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)
      const streamData = [
        `data: ${JSON.stringify({
          id: 'chatcmpl-tool-snapshot',
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_123',
                    type: 'function',
                    function: { name: 'Bash', arguments: '{"command":"' },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: 'chatcmpl-tool-snapshot',
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    type: 'function',
                    function: { arguments: '{"command":"pwd"}' },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: 'chatcmpl-tool-snapshot',
          choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        })}\n\n`,
        'data: [DONE]\\n\\n',
      ].join('')

      const unifiedResponse = await adapter.parseResponse(
        new Response(streamData),
      )

      expect(unifiedResponse.content).toEqual([
        {
          type: 'tool_use',
          id: 'call_123',
          name: 'Bash',
          input: { command: 'pwd' },
        },
      ])
    })

    test('rejects incomplete streaming tool arguments', async () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)
      const streamData = [
        'data: {"id":"chatcmpl-bad-tool","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_bad","type":"function","function":{"name":"Bash","arguments":"{\\"command\\":"}}]}}]}\n\n',
        'data: [DONE]\n\n',
      ].join('')

      await expect(
        adapter.parseResponse(new Response(streamData)),
      ).rejects.toThrow('invalid JSON arguments')
    })

    test('rejects malformed non-streaming tool calls', async () => {
      const adapter = ModelAdapterFactory.createAdapter(testModel)

      await expect(
        adapter.parseResponse({
          id: 'chatcmpl-bad-buffered-tool',
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_bad',
                    type: 'functionfunction',
                    function: {
                      name: 'Bash',
                      arguments: '{"command":"pwd"}',
                    },
                  },
                ],
              },
            },
          ],
        }),
      ).rejects.toThrow('unsupported type')

      await expect(
        adapter.parseResponse({
          id: 'chatcmpl-bad-buffered-args',
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_bad_args',
                    type: 'function',
                    function: {
                      name: 'Bash',
                      arguments: '{"command":',
                    },
                  },
                ],
              },
            },
          ],
        }),
      ).rejects.toThrow('invalid JSON arguments')
    })
  })
})
