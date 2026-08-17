import { describe, expect, it } from 'bun:test'
import { shouldDisableProviderThinking } from '#core/ai/llm/openai/params'
import { getReasoningEffort } from '#core/utils/thinking'

const profile = (effort?: string) => ({
  modelName: 'mimo-v2.5-pro',
  reasoningEffort: effort,
})

describe('provider thinking defaults', () => {
  it('keeps thinking enabled by default for tool-using turns', () => {
    expect(
      shouldDisableProviderThinking({
        model: 'mimo-v2.5-pro',
        toolSchemasLength: 30,
        reasoningEffort: null,
      }),
    ).toBe(false)
    expect(
      shouldDisableProviderThinking({
        model: 'deepseek-v4',
        toolSchemasLength: 5,
        reasoningEffort: 'high',
      }),
    ).toBe(false)
  })

  it('disables thinking for voice turns and explicit none/minimal effort', () => {
    expect(
      shouldDisableProviderThinking({
        model: 'mimo-v2.5-pro',
        toolSchemasLength: 0,
        reasoningEffort: 'medium',
        isVoice: true,
      }),
    ).toBe(true)
    expect(
      shouldDisableProviderThinking({
        model: 'deepseek-v4',
        toolSchemasLength: 0,
        reasoningEffort: 'none',
      }),
    ).toBe(true)
    expect(
      shouldDisableProviderThinking({
        model: 'mimo-v2.5-pro',
        toolSchemasLength: 10,
        reasoningEffort: 'minimal',
      }),
    ).toBe(true)
  })

  it('automatically allocates a balanced effort when unconfigured', async () => {
    expect(await getReasoningEffort(profile(undefined), [])).toBe('medium')
    expect(await getReasoningEffort(profile(''), [])).toBe('medium')
  })

  it('keeps the configured effort and skips reasoning for voice', async () => {
    expect(await getReasoningEffort(profile('high'), [])).toBe('high')
    expect(
      await getReasoningEffort(profile('high'), [], { isVoice: true }),
    ).toBe('none')
  })
})
