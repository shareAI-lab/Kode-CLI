import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import {
  applyModelConfigYamlImport,
  formatModelConfigYamlForSharing,
} from '#config'

describe('modelConfigYaml', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
  })

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      delete process.env[key]
    }
    Object.assign(process.env, originalEnv)
  })

  test('export omits plaintext apiKey and emits fromEnv placeholder', () => {
    const config: any = {
      modelProfiles: [
        {
          name: 'Model A',
          provider: 'openai',
          modelName: 'model-a',
          apiKey: 'SECRET_KEY_SHOULD_NOT_APPEAR',
          maxTokens: 1024,
          contextLength: 128000,
          isActive: true,
          createdAt: 1,
        },
      ],
      modelPointers: {
        main: 'model-a',
        task: 'model-a',
        compact: 'model-a',
        quick: 'model-a',
      },
    }

    const yamlText = formatModelConfigYamlForSharing(config)
    expect(yamlText).not.toContain('SECRET_KEY_SHOULD_NOT_APPEAR')
    expect(yamlText).toContain('fromEnv')
  })

  test('export uses OPENROUTER_API_KEY for OpenRouter profiles', () => {
    const config: any = {
      modelProfiles: [
        {
          name: 'OpenRouter Main',
          provider: 'openrouter',
          modelName: 'anthropic/claude-sonnet-4.5',
          baseURL: 'https://openrouter.ai/api/v1',
          apiKey: 'SECRET_KEY_SHOULD_NOT_APPEAR',
          maxTokens: 8192,
          contextLength: 200000,
          isActive: true,
          createdAt: 1,
        },
      ],
      modelPointers: {
        main: 'anthropic/claude-sonnet-4.5',
        task: 'anthropic/claude-sonnet-4.5',
        compact: 'anthropic/claude-sonnet-4.5',
        quick: 'anthropic/claude-sonnet-4.5',
      },
    }

    const yamlText = formatModelConfigYamlForSharing(config)

    expect(yamlText).toContain('provider: openrouter')
    expect(yamlText).toContain('baseURL: https://openrouter.ai/api/v1')
    expect(yamlText).toContain('fromEnv: OPENROUTER_API_KEY')
    expect(yamlText).not.toContain('SECRET_KEY_SHOULD_NOT_APPEAR')
  })

  test('export uses ORCAROUTER_API_KEY for OrcaRouter profiles', () => {
    const config: any = {
      modelProfiles: [
        {
          name: 'OrcaRouter Main',
          provider: 'orcarouter',
          modelName: 'anthropic/claude-sonnet-4.6',
          baseURL: 'https://api.orcarouter.ai/v1',
          apiKey: 'SECRET_KEY_SHOULD_NOT_APPEAR',
          maxTokens: 8192,
          contextLength: 200000,
          isActive: true,
          createdAt: 1,
        },
      ],
      modelPointers: {
        main: 'anthropic/claude-sonnet-4.6',
        task: 'anthropic/claude-sonnet-4.6',
        compact: 'anthropic/claude-sonnet-4.6',
        quick: 'anthropic/claude-sonnet-4.6',
      },
    }

    const yamlText = formatModelConfigYamlForSharing(config)

    expect(yamlText).toContain('provider: orcarouter')
    expect(yamlText).toContain('baseURL: https://api.orcarouter.ai/v1')
    expect(yamlText).toContain('fromEnv: ORCAROUTER_API_KEY')
    expect(yamlText).not.toContain('SECRET_KEY_SHOULD_NOT_APPEAR')
  })

  test('import resolves apiKey from env and applies pointers', () => {
    process.env.TEST_OPENAI_KEY = 'resolved-from-env'

    const existingConfig: any = {
      modelProfiles: [],
      modelPointers: { main: '', task: '', compact: '', quick: '' },
    }

    const yamlText = `
version: 1
profiles:
  - name: OpenAI Main
    provider: openai
    modelName: gpt-4o
    maxTokens: 1024
    contextLength: 128000
    apiKey:
      fromEnv: TEST_OPENAI_KEY
pointers:
  main: gpt-4o
  quick: OpenAI Main
`

    const { nextConfig, warnings } = applyModelConfigYamlImport(
      existingConfig,
      yamlText,
      { replace: true },
    )

    expect(warnings).toEqual([])
    expect(nextConfig.modelProfiles?.[0]?.apiKey).toBe('resolved-from-env')
    expect(nextConfig.modelPointers?.main).toBe('gpt-4o')
    expect(nextConfig.modelPointers?.quick).toBe('gpt-4o')
  })

  test('import preserves existing apiKey when env var is missing', () => {
    const existingConfig: any = {
      modelProfiles: [
        {
          name: 'Existing',
          provider: 'openai',
          modelName: 'gpt-4o',
          apiKey: 'existing-key',
          maxTokens: 1024,
          contextLength: 128000,
          isActive: true,
          createdAt: 1,
        },
      ],
      modelPointers: { main: 'gpt-4o', task: '', compact: '', quick: '' },
    }

    const yamlText = `
version: 1
profiles:
  - name: OpenAI Main
    provider: openai
    modelName: gpt-4o
    maxTokens: 1024
    contextLength: 128000
    apiKey:
      fromEnv: MISSING_ENV
`

    const { nextConfig } = applyModelConfigYamlImport(
      existingConfig,
      yamlText,
      {
        replace: true,
      },
    )

    expect(nextConfig.modelProfiles?.[0]?.apiKey).toBe('existing-key')
  })
})
