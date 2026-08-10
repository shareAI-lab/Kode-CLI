import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { ModelManager } from '../../utils/model'
import type { ModelProfile } from '../../utils/config'

function makeProfile(
  profile: Partial<ModelProfile> & {
    name: string
    modelName: string
    contextLength: number
    createdAt: number
  },
): ModelProfile {
  return {
    name: profile.name,
    provider: profile.provider ?? 'openai',
    modelName: profile.modelName,
    baseURL: profile.baseURL,
    apiKey: profile.apiKey ?? '',
    apiKeyEnv:
      'apiKeyEnv' in profile ? profile.apiKeyEnv : 'TEST_MODEL_API_KEY',
    maxTokens: profile.maxTokens ?? 1024,
    contextLength: profile.contextLength,
    reasoningEffort: profile.reasoningEffort,
    isActive: profile.isActive ?? true,
    createdAt: profile.createdAt,
    lastUsed: profile.lastUsed,
    isGPT5: profile.isGPT5,
    validationStatus: profile.validationStatus,
    lastValidation: profile.lastValidation,
  }
}

describe('ModelManager model switching', () => {
  const originalNodeEnv = process.env.NODE_ENV
  const originalTestModelApiKey = process.env.TEST_MODEL_API_KEY

  beforeAll(() => {
    process.env.NODE_ENV = 'test'
    process.env.TEST_MODEL_API_KEY = 'runtime-test-key'
  })

  afterAll(() => {
    if (originalTestModelApiKey === undefined) {
      delete process.env.TEST_MODEL_API_KEY
    } else {
      process.env.TEST_MODEL_API_KEY = originalTestModelApiKey
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV
      return
    }
    process.env.NODE_ENV = originalNodeEnv
  })

  test('switchToNextModel updates main pointer and affects resolution', () => {
    const modelA = makeProfile({
      name: 'Model A',
      modelName: 'model-a',
      contextLength: 128_000,
      createdAt: 1,
    })
    const modelB = makeProfile({
      name: 'Model B',
      modelName: 'model-b',
      contextLength: 64_000,
      createdAt: 2,
    })

    const config: any = {
      modelProfiles: [modelA, modelB],
      modelPointers: {
        main: modelA.modelName,
        task: modelA.modelName,
        compact: modelA.modelName,
        quick: modelA.modelName,
      },
      defaultModelName: modelA.modelName,
    }

    const manager = new ModelManager(config)
    const result = manager.switchToNextModel(1000)

    expect(result.success).toBe(true)
    expect(config.modelPointers.main).toBe(modelB.modelName)
    expect(manager.resolveModelWithInfo('main').profile?.modelName).toBe(
      modelB.modelName,
    )
  })

  test('switchToNextModel skips incompatible models when possible', () => {
    const modelA = makeProfile({
      name: 'Model A',
      modelName: 'model-a',
      contextLength: 128_000,
      createdAt: 1,
    })
    const modelB = makeProfile({
      name: 'Model B Small',
      modelName: 'model-b-small',
      contextLength: 32_000,
      createdAt: 2,
    })
    const modelC = makeProfile({
      name: 'Model C',
      modelName: 'model-c',
      contextLength: 256_000,
      createdAt: 3,
    })

    const config: any = {
      modelProfiles: [modelA, modelB, modelC],
      modelPointers: {
        main: modelA.modelName,
        task: modelA.modelName,
        compact: modelA.modelName,
        quick: modelA.modelName,
      },
      defaultModelName: modelA.modelName,
    }

    const manager = new ModelManager(config)
    const result = manager.switchToNextModel(60_000)

    expect(result.success).toBe(true)
    expect(config.modelPointers.main).toBe(modelC.modelName)
    expect(result.message).toContain('skipped 1 incompatible')
  })

  test('switchToNextModel blocks when no alternative model can fit context', () => {
    const modelA = makeProfile({
      name: 'Model A',
      modelName: 'model-a',
      contextLength: 128_000,
      createdAt: 1,
    })
    const modelB = makeProfile({
      name: 'Model B Small',
      modelName: 'model-b-small',
      contextLength: 32_000,
      createdAt: 2,
    })

    const config: any = {
      modelProfiles: [modelA, modelB],
      modelPointers: {
        main: modelA.modelName,
        task: modelA.modelName,
        compact: modelA.modelName,
        quick: modelA.modelName,
      },
      defaultModelName: modelA.modelName,
    }

    const manager = new ModelManager(config)
    const result = manager.switchToNextModel(60_000)

    expect(result.success).toBe(false)
    expect(result.blocked).toBe(true)
    expect(config.modelPointers.main).toBe(modelA.modelName)
    expect(result.message).toContain('Keeping')
  })

  test('upsertModel updates existing model parameters and preserves metadata', async () => {
    const modelA = makeProfile({
      name: 'Model A',
      modelName: 'model-a',
      apiKey: 'existing-key',
      maxTokens: 1024,
      contextLength: 128_000,
      reasoningEffort: 'medium',
      createdAt: 1,
      lastUsed: 2,
      isGPT5: true,
      validationStatus: 'valid',
      lastValidation: 3,
    })

    const config: any = {
      modelProfiles: [modelA],
      modelPointers: {
        main: modelA.modelName,
        task: modelA.modelName,
        compact: modelA.modelName,
        quick: modelA.modelName,
      },
      defaultModelName: modelA.modelName,
    }

    const manager = new ModelManager(config)
    const modelId = await manager.upsertModel({
      name: 'Model A Updated',
      provider: 'openai',
      modelName: modelA.modelName,
      baseURL: 'https://example.com/v1',
      apiKey: '',
      maxTokens: 8192,
      contextLength: 256_000,
      reasoningEffort: 'high',
    })

    expect(modelId).toBe(modelA.modelName)
    expect(manager.getAllConfiguredModels()).toHaveLength(1)

    const updated = manager.getAllConfiguredModels()[0]!
    expect(updated.name).toBe('Model A Updated')
    expect(updated.baseURL).toBe('https://example.com/v1')
    // Callers never receive a legacy plaintext value, even when an old config
    // still contains one for manual rotation.
    expect(updated.apiKey).toBe('')
    expect(updated.maxTokens).toBe(8192)
    expect(updated.contextLength).toBe(256_000)
    expect(updated.reasoningEffort).toBe('high')
    expect(updated.createdAt).toBe(1)
    expect(updated.lastUsed).toBe(2)
    expect(updated.isActive).toBe(true)
    expect(updated.isGPT5).toBe(true)
    expect(updated.validationStatus).toBe('valid')
    expect(updated.lastValidation).toBe(3)
  })

  test('blocks a legacy plaintext-only profile and uses its env reference at runtime', () => {
    const legacyProfile = makeProfile({
      name: 'Legacy Model',
      modelName: 'legacy-model',
      apiKey: 'legacy-key-not-for-runtime',
      apiKeyEnv: undefined,
      contextLength: 128_000,
      createdAt: 1,
    })
    const config: any = {
      modelProfiles: [legacyProfile],
      modelPointers: {
        main: legacyProfile.modelName,
        task: legacyProfile.modelName,
        compact: legacyProfile.modelName,
        quick: legacyProfile.modelName,
      },
    }
    const manager = new ModelManager(config)

    const blocked = manager.resolveModelWithInfo('main')
    expect(blocked.success).toBe(false)
    expect(blocked.error).toContain('environment-variable credential reference')
    expect(blocked.error).toContain('rotate')
    expect(manager.getAllConfiguredModels()[0]?.apiKey).toBe('')

    legacyProfile.apiKeyEnv = 'TEST_MODEL_API_KEY'
    const resolved = manager.resolveModelWithInfo('main')
    expect(resolved.success).toBe(true)
    expect(resolved.profile?.apiKey).toBe('runtime-test-key')
  })

  test('removeModel clears pointers and default when deleting the last model', () => {
    const modelA = makeProfile({
      name: 'Model A',
      modelName: 'model-a',
      contextLength: 128_000,
      createdAt: 1,
    })

    const config: any = {
      modelProfiles: [modelA],
      modelPointers: {
        main: modelA.modelName,
        task: modelA.modelName,
        compact: modelA.modelName,
        quick: modelA.modelName,
      },
      defaultModelName: modelA.modelName,
    }

    const manager = new ModelManager(config)
    manager.removeModel(modelA.modelName)

    expect(manager.getAllConfiguredModels()).toEqual([])
    expect(config.modelProfiles).toEqual([])
    expect(config.modelPointers).toEqual({
      main: '',
      task: '',
      compact: '',
      quick: '',
    })
    expect(config.defaultModelName).toBe('')
  })

  test('removeModel reassigns pointers when deleting the main model', () => {
    const modelA = makeProfile({
      name: 'Model A',
      modelName: 'model-a',
      contextLength: 128_000,
      createdAt: 1,
    })
    const modelB = makeProfile({
      name: 'Model B',
      modelName: 'model-b',
      contextLength: 256_000,
      createdAt: 2,
    })

    const config: any = {
      modelProfiles: [modelA, modelB],
      modelPointers: {
        main: modelA.modelName,
        task: modelA.modelName,
        compact: modelA.modelName,
        quick: modelA.modelName,
      },
      defaultModelName: modelA.modelName,
    }

    const manager = new ModelManager(config)
    manager.removeModel(modelA.modelName)

    expect(
      manager.getAllConfiguredModels().map(model => model.modelName),
    ).toEqual([modelB.modelName])
    expect(config.modelPointers).toEqual({
      main: modelB.modelName,
      task: modelB.modelName,
      compact: modelB.modelName,
      quick: modelB.modelName,
    })
    expect(config.defaultModelName).toBe(modelB.modelName)
  })
})
