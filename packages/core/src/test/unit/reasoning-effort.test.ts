import { describe, expect, test } from 'bun:test'

import { getReasoningEffort } from '#core/utils/thinking'

describe('getReasoningEffort', () => {
  test('does not drop low effort profiles (0 is valid maxEffort)', async () => {
    const result = await getReasoningEffort(
      { reasoningEffort: 'low' },
      [],
      { thinkingTokens: 5_000 },
    )
    expect(result).toBe('low')
  })

  test('caps effort by profile max and scales with thinking tokens', async () => {
    await expect(
      getReasoningEffort(
        { reasoningEffort: 'medium' },
        [],
        { thinkingTokens: 40_000 },
      ),
    ).resolves.toBe('medium')
    await expect(
      getReasoningEffort(
        { reasoningEffort: 'high' },
        [],
        { thinkingTokens: 40_000 },
      ),
    ).resolves.toBe('high')
  })
})
