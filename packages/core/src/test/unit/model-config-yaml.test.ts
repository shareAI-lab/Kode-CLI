import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import {
  applyModelConfigYamlImport,
  formatModelConfigYamlForSharing,
  resolveModelApiKey,
  validateApiKeyEnvironmentReference,
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

  test('import preserves an environment reference without resolving it', () => {
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
    expect(nextConfig.modelProfiles?.[0]?.apiKey).toBe('')
    expect(nextConfig.modelProfiles?.[0]?.apiKeyEnv).toBe('TEST_OPENAI_KEY')
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
    expect(nextConfig.modelProfiles?.[0]?.apiKeyEnv).toBe('MISSING_ENV')
  })

  test('import keeps explicit legacy credentials for backward compatibility', () => {
    const existingConfig: any = {
      modelProfiles: [],
      modelPointers: { main: '', task: '', compact: '', quick: '' },
    }

    const { nextConfig } = applyModelConfigYamlImport(
      existingConfig,
      `
version: 1
profiles:
  - name: Legacy OpenAI
    provider: openai
    modelName: gpt-4o
    maxTokens: 1024
    contextLength: 128000
    apiKey:
      value: legacy-local-key
`,
      { replace: true },
    )

    expect(nextConfig.modelProfiles?.[0]?.apiKey).toBe('legacy-local-key')
    expect(nextConfig.modelProfiles?.[0]?.apiKeyEnv).toBeUndefined()
  })

  test('resolves a credential reference only for a request', () => {
    process.env.TEST_OPENAI_KEY = 'resolved-from-env'

    expect(
      resolveModelApiKey({ apiKey: '', apiKeyEnv: 'TEST_OPENAI_KEY' } as any),
    ).toBe('resolved-from-env')
    expect(resolveModelApiKey({ apiKey: 'legacy-local-key' } as any)).toBe(
      'legacy-local-key',
    )
  })

  test('accepts only safe environment variable names', () => {
    expect(validateApiKeyEnvironmentReference('OPENAI_API_KEY')).toBeNull()
    expect(validateApiKeyEnvironmentReference('1OPENAI_API_KEY')).toContain(
      'cannot start with a digit',
    )
    expect(validateApiKeyEnvironmentReference('OPENAI API KEY')).toContain(
      'letters, digits, and underscores',
    )
  })
})
