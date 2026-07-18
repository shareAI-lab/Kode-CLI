import { describe, expect, test } from 'bun:test'

import { detectModelFamily, isDeepSeekReasonerModel } from './modelFamilies'
import {
  buildOpenAIChatCompletionCreateParams,
  shouldDisableProviderThinking,
} from '../llm/openai/params'
import { estimateCostUSD, normalizeUsage } from '../llm/openai/usage'
import { MODEL_COSTS, resolveModelCostTier } from '#config'

describe('model families', () => {
  test('detects deepseek / mimo / gpt5', () => {
    expect(detectModelFamily('deepseek-v4-flash')).toBe('deepseek')
    expect(detectModelFamily('mimo-v2.5-pro')).toBe('mimo')
    expect(detectModelFamily('gpt-5-mini')).toBe('gpt5')
    expect(isDeepSeekReasonerModel('deepseek-reasoner')).toBe(true)
  })
})

describe('provider thinking defaults', () => {
  test('deepseek disables thinking for tools and low effort', () => {
    expect(
      shouldDisableProviderThinking({
        model: 'deepseek-v4-flash',
        toolSchemasLength: 1,
        reasoningEffort: 'high',
      }),
    ).toBe(true)
    expect(
      shouldDisableProviderThinking({
        model: 'deepseek-v4-flash',
        toolSchemasLength: 0,
        reasoningEffort: 'low',
      }),
    ).toBe(true)
    expect(
      shouldDisableProviderThinking({
        model: 'deepseek-v4-flash',
        toolSchemasLength: 0,
        reasoningEffort: 'high',
      }),
    ).toBe(false)
  })

  test('recognizes DeepSeek provider aliases', () => {
    expect(
      shouldDisableProviderThinking({
        model: 'team-alias',
        provider: 'deepseek',
        toolSchemasLength: 1,
        reasoningEffort: 'high',
      }),
    ).toBe(true)
  })

  test('params set thinking disabled and max_tokens for deepseek', () => {
    const params = buildOpenAIChatCompletionCreateParams({
      model: 'deepseek-v4-flash',
      maxTokens: 100,
      messages: [
        { role: 'system', content: 'sys1' },
        { role: 'system', content: 'sys2' },
        { role: 'user', content: 'hi' },
      ],
      temperature: 0.5,
      stream: false,
      toolSchemas: [],
      reasoningEffort: 'low',
      provider: 'deepseek',
    })
    expect(params.max_tokens).toBe(100)
    expect(params.max_completion_tokens).toBeUndefined()
    expect((params as any).thinking).toEqual({ type: 'disabled' })
    expect(params.messages).toEqual([
      { role: 'system', content: 'sys1' },
      { role: 'system', content: 'sys2' },
      { role: 'user', content: 'hi' },
    ])
  })

  test('deepseek high effort enables thinking without tools', () => {
    const params = buildOpenAIChatCompletionCreateParams({
      model: 'deepseek-v4-pro',
      maxTokens: 200,
      messages: [{ role: 'user', content: 'think' }],
      temperature: 0.7,
      stream: false,
      toolSchemas: [],
      reasoningEffort: 'high',
    })
    expect((params as any).thinking).toEqual({ type: 'enabled' })
    expect(params.reasoning_effort).toBe('high')
    expect(params.temperature).toBeUndefined()
  })

  test('DeepSeek provider aliases enable thinking without tools', () => {
    const params = buildOpenAIChatCompletionCreateParams({
      model: 'team-alias',
      provider: 'deepseek',
      maxTokens: 200,
      messages: [{ role: 'user', content: 'think' }],
      temperature: 0.7,
      stream: false,
      toolSchemas: [],
      reasoningEffort: 'high',
    })
    expect((params as any).thinking).toEqual({ type: 'enabled' })
    expect(params.temperature).toBeUndefined()
  })

  test('deepseek-reasoner strips temperature', () => {
    const params = buildOpenAIChatCompletionCreateParams({
      model: 'deepseek-reasoner',
      maxTokens: 50,
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0.9,
      stream: false,
      toolSchemas: [],
    })
    expect(params.temperature).toBeUndefined()
  })
})

describe('usage cache mapping', () => {
  test('maps DeepSeek prompt_cache_hit/miss tokens', () => {
    const u = normalizeUsage({
      prompt_cache_hit_tokens: 900,
      prompt_cache_miss_tokens: 100,
      completion_tokens: 20,
      completion_tokens_details: { reasoning_tokens: 5 },
    })
    expect(u.cache_read_input_tokens).toBe(900)
    expect(u.cache_creation_input_tokens).toBe(0)
    expect(u.input_tokens).toBe(100)
    expect(u.prompt_tokens).toBe(1000)
    expect(u.output_tokens).toBe(20)
    expect(u.reasoningTokens).toBe(5)
  })

  test('estimateCostUSD discounts cache hits for deepseek rates', () => {
    const missOnly = estimateCostUSD({
      inputTokens: 1000,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      rates: MODEL_COSTS.deepseekFlash,
    })
    const withHit = estimateCostUSD({
      inputTokens: 100,
      outputTokens: 0,
      cacheReadInputTokens: 900,
      rates: MODEL_COSTS.deepseekFlash,
    })
    expect(withHit).toBeLessThan(missOnly)
    expect(withHit).toBeCloseTo(0.00001652, 12)
    expect(resolveModelCostTier('deepseek-v4-flash')).toBe('deepseekFlash')
    expect(resolveModelCostTier('deepseek-v4-pro')).toBe('deepseekPro')
    expect(resolveModelCostTier('deepseek-reasoner')).toBe('deepseekFlash')
    expect(resolveModelCostTier('team-alias', 'deepseek')).toBe('deepseekFlash')
    expect(MODEL_COSTS.deepseekPro.promptCacheReadPerMillionTokens).toBe(
      0.003625,
    )
  })
})
