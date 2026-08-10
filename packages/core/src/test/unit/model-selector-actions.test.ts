import { describe, expect, test } from 'bun:test'

import { runConnectionTestFlow } from '#ui-ink/components/ModelSelector/flow/actions/connectionTest'
import { fetchModelsForProvider } from '#ui-ink/components/ModelSelector/flow/actions/fetchModels'
import { handleProviderSelection } from '#ui-ink/components/ModelSelector/flow/actions/providerSelection'
import { applyPointersForNewModel } from '#ui-ink/components/ModelSelector/flow/actions/saveConfiguration'
import { saveModelConfiguration } from '#ui-ink/components/ModelSelector/flow/actions/saveConfiguration'

describe('model selector actions', () => {
  test('provider -> apiKey -> model (anthropic happy path)', async () => {
    const navigations: string[] = []
    let selectedProvider: any = null
    let providerBaseUrl: any = null

    await handleProviderSelection('anthropic', {
      navigateTo: screen => {
        navigations.push(screen)
      },
      setPartnerProviderFocusIndex: () => {},
      setCodingPlanFocusIndex: () => {},
      setSelectedProvider: provider => {
        selectedProvider = provider
      },
      setProviderBaseUrl: baseUrl => {
        providerBaseUrl = baseUrl
      },
      saveConfiguration: async () => null,
      onDone: () => {},
      selectedModel: '',
    })

    expect(selectedProvider).toBe('anthropic')
    expect(navigations).toEqual(['apiKey'])
    expect(typeof providerBaseUrl).toBe('string')

    const fakeModels = [
      {
        model: 'claude-3-5-sonnet-latest',
        provider: 'anthropic',
        max_tokens: 8192,
        supports_vision: false,
        supports_function_calling: true,
        supports_reasoning_effort: false,
      },
    ]

    const loadStates: boolean[] = []
    const errors: Array<string | null> = []
    let availableModels: any = null
    const nav2: Array<'model' | 'modelInput'> = []

    const result = await fetchModelsForProvider({
      selectedProvider: 'anthropic',
      apiKey: 'test-api-key',
      providerBaseUrl: 'https://api.anthropic.com',
      customBaseUrl: '',
      modelFetchers: {
        fetchAnthropicCompatibleProviderModels: async () => fakeModels,
      },
      setIsLoadingModels: v => loadStates.push(v),
      setModelLoadError: e => errors.push(e),
      setAvailableModels: m => {
        availableModels = m
      },
      navigateTo: screen => nav2.push(screen),
    })

    expect(result).toEqual(fakeModels)
    expect(availableModels).toEqual(fakeModels)
    expect(nav2).toEqual(['model'])
    expect(loadStates[0]).toBe(true)
    expect(loadStates[loadStates.length - 1]).toBe(false)
    expect(errors[0]).toBeNull()
  })

  test('onboarding assigns all pointers', () => {
    const setModelPointerCalls: Array<[string, string]> = []
    const setAllPointersCalls: string[] = []

    applyPointersForNewModel({
      modelId: 'm1',
      isOnboarding: true,
      targetPointer: 'task',
      setModelPointerFn: (pointer, modelId) => {
        setModelPointerCalls.push([String(pointer), String(modelId)])
      },
      setAllPointersToModelFn: modelId => {
        setAllPointersCalls.push(String(modelId))
      },
    })

    expect(setModelPointerCalls).toEqual([['main', 'm1']])
    expect(setAllPointersCalls).toEqual(['m1'])
  })

  test('saving a profile persists an environment reference but not an API key', async () => {
    let savedProfile: any = null

    await saveModelConfiguration({
      provider: 'openai',
      model: 'gpt-4o',
      providerBaseUrl: 'https://api.openai.com/v1',
      resourceName: '',
      customBaseUrl: '',
      apiKeyEnv: 'TEST_OPENAI_KEY',
      maxTokens: '1024',
      contextLength: 128000,
      reasoningEffort: 'medium',
      getModelManagerFn: () =>
        ({
          upsertModel: async (profile: any) => {
            savedProfile = profile
            return profile.modelName
          },
        }) as any,
    })

    expect(savedProfile.apiKey).toBe('')
    expect(savedProfile.apiKeyEnv).toBe('TEST_OPENAI_KEY')
  })

  test('connection test failure does not auto-advance', async () => {
    const navigations: string[] = []
    const timeouts: number[] = []
    const setTimeoutFn = (_callback: () => void, delayMs: number) => {
      timeouts.push(delayMs)
    }

    const result = await runConnectionTestFlow({
      params: {
        selectedProvider: 'openai',
        selectedModel: 'gpt-4',
        apiKey: 'test-api-key',
        maxTokens: '8192',
        providerBaseUrl: 'https://api.openai.com/v1',
        customBaseUrl: '',
        resourceName: '',
        requestStrategy: 'auto',
      },
      navigateTo: screen => {
        navigations.push(screen)
      },
      setTimeoutFn,
      performConnectionTestFn: async () => ({
        success: false,
        message: '❌ openai connection failed',
        endpoint: '/chat/completions',
        details: 'network error',
      }),
    })

    expect(result.success).toBe(false)
    expect(timeouts).toEqual([])
    expect(navigations).toEqual([])
  })
})
