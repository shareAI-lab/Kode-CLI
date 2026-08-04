import { describe, expect, test } from 'bun:test'
import { validateAndRepairGPT5Profile } from '#config'

describe('OpenRouter GPT-5 config validation', () => {
  test('repairs missing GPT-5 baseURL to OpenRouter for OpenRouter profiles', () => {
    const repaired = validateAndRepairGPT5Profile({
      name: 'OpenRouter GPT-5',
      provider: 'openrouter',
      modelName: 'openai/gpt-5',
      apiKey: 'test-key',
      maxTokens: 8192,
      contextLength: 128000,
      isActive: true,
      createdAt: 1,
    })

    expect(repaired.baseURL).toBe('https://openrouter.ai/api/v1')
    expect(repaired.validationStatus).toBe('auto_repaired')
  })
})

describe('OrcaRouter GPT-5 config validation', () => {
  test('repairs missing GPT-5 baseURL to OrcaRouter for OrcaRouter profiles', () => {
    const repaired = validateAndRepairGPT5Profile({
      name: 'OrcaRouter GPT-5',
      provider: 'orcarouter',
      modelName: 'openai/gpt-5.5',
      apiKey: 'test-key',
      maxTokens: 8192,
      contextLength: 128000,
      isActive: true,
      createdAt: 1,
    })

    expect(repaired.baseURL).toBe('https://api.orcarouter.ai/v1')
    expect(repaired.validationStatus).toBe('auto_repaired')
  })
})
