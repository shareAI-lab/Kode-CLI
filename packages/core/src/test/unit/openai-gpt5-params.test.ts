import { describe, expect, test } from 'bun:test'
import { buildOpenAIChatCompletionCreateParams } from '#core/ai/llm/openai'
import { estimateCostUSD, normalizeUsage } from '#core/ai/llm/openai/usage'
import { MODEL_COSTS } from '#core/utils/config'

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

  test('MiMo tool calls keep thinking and use max_completion_tokens', () => {
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
    expect((params as { thinking?: unknown }).thinking).toBeUndefined()
  })

  test('MiMo keeps thinking enabled without sending OpenAI reasoning effort', () => {
    for (const effort of ['low', 'high', 'xhigh', 'max'] as const) {
      const params = buildOpenAIChatCompletionCreateParams({
        model: 'mimo-v2.5-pro',
        maxTokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0,
        stream: false,
        toolSchemas: [],
        reasoningEffort: effort,
      })
      expect((params as { thinking?: unknown }).thinking).toBeUndefined()
      expect(params.reasoning_effort).toBeUndefined()
    }
  })

  test('MiMo disables thinking only for none/minimal effort or voice', () => {
    const none = buildOpenAIChatCompletionCreateParams({
      model: 'mimo-v2.5-pro',
      maxTokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0,
      stream: false,
      toolSchemas: [],
      reasoningEffort: 'none',
    })
    expect((none as { thinking?: unknown }).thinking).toEqual({
      type: 'disabled',
    })

    const voice = buildOpenAIChatCompletionCreateParams({
      model: 'mimo-v2.5-pro',
      maxTokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0,
      stream: false,
      toolSchemas: [],
      isVoice: true,
    })
    expect((voice as { thinking?: unknown }).thinking).toEqual({
      type: 'disabled',
    })
  })

  test('DeepSeek preserves system message boundaries and uses max_tokens', () => {
    const params = buildOpenAIChatCompletionCreateParams({
      model: 'deepseek-v4-flash',
      maxTokens: 111,
      messages: [
        { role: 'system', content: 'part-a' },
        { role: 'system', content: 'part-b' },
        { role: 'user', content: 'q' },
      ],
      temperature: 0.2,
      stream: false,
      toolSchemas: [],
      reasoningEffort: 'low',
      provider: 'deepseek',
    })
    expect(params.max_tokens).toBe(111)
    expect(params.max_completion_tokens).toBeUndefined()
    expect(params.messages).toEqual([
      { role: 'system', content: 'part-a' },
      { role: 'system', content: 'part-b' },
      { role: 'user', content: 'q' },
    ])
    expect((params as { thinking?: unknown }).thinking).toBeUndefined()
  })

  test('DeepSeek cache hits and misses preserve token and billing semantics', () => {
    const usage = normalizeUsage({
      prompt_cache_hit_tokens: 900,
      prompt_cache_miss_tokens: 100,
      completion_tokens: 20,
    })

    expect(usage).toMatchObject({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 0,
      prompt_tokens: 1000,
    })
    expect(
      estimateCostUSD({
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadInputTokens: usage.cache_read_input_tokens ?? undefined,
        cacheCreationInputTokens:
          usage.cache_creation_input_tokens ?? undefined,
        rates: MODEL_COSTS.deepseekFlash,
      }),
    ).toBeCloseTo(0.00002212, 12)
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
    expect(params.tools!.length).toBe(1)
    expect(params.reasoning_effort).toBe('medium')
  })
})
