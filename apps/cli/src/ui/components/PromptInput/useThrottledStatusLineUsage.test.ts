import { describe, expect, test } from 'bun:test'
import { arePromptStatusLineUsagesEqual } from './useThrottledStatusLineUsage'

describe('throttled status line usage', () => {
  test('keeps the previous state when streamed updates do not change usage', () => {
    expect(
      arePromptStatusLineUsagesEqual(
        {
          totalInputTokens: 10,
          totalOutputTokens: 5,
          totalCostUSD: 1.25,
          currentUsage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 3,
          },
        },
        {
          totalInputTokens: 10,
          totalOutputTokens: 5,
          totalCostUSD: 1.25,
          currentUsage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 3,
          },
        },
      ),
    ).toBe(true)
  })

  test('updates the state when the latest assistant usage changes', () => {
    expect(
      arePromptStatusLineUsagesEqual(
        {
          totalInputTokens: 10,
          totalOutputTokens: 5,
          totalCostUSD: 1.25,
          currentUsage: null,
        },
        {
          totalInputTokens: 10,
          totalOutputTokens: 6,
          totalCostUSD: 1.5,
          currentUsage: {
            input_tokens: 10,
            output_tokens: 6,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      ),
    ).toBe(false)
  })
})
