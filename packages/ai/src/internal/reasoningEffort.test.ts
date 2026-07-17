import { describe, expect, test } from 'bun:test'

import { resolveReasoningEffort } from './reasoningEffort'

describe('resolveReasoningEffort', () => {
  test('keeps low effort (0) instead of treating it as missing', () => {
    expect(
      resolveReasoningEffort({
        modelProfile: { reasoningEffort: 'low' },
        thinkingTokens: 5_000,
      }),
    ).toBe('low')
  })

  test('scales with thinking tokens and caps by profile', () => {
    expect(
      resolveReasoningEffort({
        modelProfile: { reasoningEffort: 'medium' },
        thinkingTokens: 40_000,
      }),
    ).toBe('medium')
    expect(
      resolveReasoningEffort({
        modelProfile: { reasoningEffort: 'high' },
        thinkingTokens: 40_000,
      }),
    ).toBe('high')
    expect(
      resolveReasoningEffort({
        modelProfile: { reasoningEffort: 'high' },
        thinkingTokens: 5_000,
      }),
    ).toBe('low')
  })
})
