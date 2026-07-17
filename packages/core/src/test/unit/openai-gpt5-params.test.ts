import { describe, expect, test } from 'bun:test'
import { buildOpenAIChatCompletionCreateParams } from '#core/ai/llm/openai'

describe('OpenAI Chat Completions params (GPT-5 branch)', () => {
  test('GPT-5 models use max_completion_tokens (not max_tokens)', () => {
    const params = buildOpenAIChatCompletionCreateParams({
      model: 'gpt-5-mini',
      maxTokens: 123,
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 1,
      stream: false,
      toolSchemas: [],
    })

    expect(params.max_completion_tokens).toBe(123)
    expect(params.max_tokens).toBeUndefined()
  })

  test('non GPT-5 models use max_tokens (not max_completion_tokens)', () => {
    const params = buildOpenAIChatCompletionCreateParams({
      model: 'gpt-4o-mini',
      maxTokens: 456,
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7,
      stream: false,
      toolSchemas: [],
    })

    expect(params.max_tokens).toBe(456)
    expect(params.max_completion_tokens).toBeUndefined()
  })

  test('MiMo tool calls disable thinking and use max_completion_tokens', () => {
    const params = buildOpenAIChatCompletionCreateParams({
      model: 'mimo-v2.5-pro',
      maxTokens: 789,
      messages: [{ role: 'user', content: 'inspect this repository' }],
      temperature: 1,
      stream: true,
      toolSchemas: [
        {
          type: 'function',
          function: {
            name: 'Read',
            description: 'Read a file',
            parameters: {},
          },
        },
      ],
    })

    expect(params.max_completion_tokens).toBe(789)
    expect(params.max_tokens).toBeUndefined()
    expect(params.tool_choice).toBe('auto')
    expect((params as { thinking?: unknown }).thinking).toEqual({
      type: 'disabled',
    })
  })

  test('MiMo disables thinking by default (low/unset effort) to protect completion budget', () => {
    const plain = buildOpenAIChatCompletionCreateParams({
      model: 'mimo-v2.5-pro',
      maxTokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0,
      stream: false,
      toolSchemas: [],
      reasoningEffort: 'low',
    })
    expect((plain as { thinking?: unknown }).thinking).toEqual({
      type: 'disabled',
    })

    const high = buildOpenAIChatCompletionCreateParams({
      model: 'mimo-v2.5-pro',
      maxTokens: 512,
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0,
      stream: false,
      toolSchemas: [],
      reasoningEffort: 'high',
    })
    expect((high as { thinking?: unknown }).thinking).toBeUndefined()
  })

  test('stream/tools/stop/reasoning flags are wired', () => {
    const params = buildOpenAIChatCompletionCreateParams({
      model: 'gpt-5',
      maxTokens: 42,
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 1,
      stream: true,
      stopSequences: ['STOP'],
      reasoningEffort: 'medium',
      toolSchemas: [
        {
          type: 'function',
          function: {
            name: 'TestTool',
            description: 'x',
            parameters: {},
          },
        },
      ],
    })

    expect(params.stream).toBe(true)
    expect(params.stream_options?.include_usage).toBe(true)
    expect(params.stop).toEqual(['STOP'])
    expect(params.tool_choice).toBe('auto')
    expect(Array.isArray(params.tools)).toBe(true)
    expect(params.tools.length).toBe(1)
    expect(params.reasoning_effort).toBe('medium')
  })
})
