import { useEffect, useRef } from 'react'
import { debug as debugLogger } from '#core/utils/debugLogger'
import { fetchModelsForProvider } from './flow/actions/fetchModels'
import {
  DEFAULT_CONTEXT_LENGTH,
  DEFAULT_MAX_TOKENS,
  MAX_TOKENS_OPTIONS,
  getReasoningEffortOptions,
  REQUEST_STRATEGY_OPTIONS,
} from './flow/options'
import type { ModelInfo } from './flow/types'
import * as modelFetchers from './flow/modelFetchers'
import {
  clearSessionApiKey,
  getSuggestedApiKeyEnvVar,
  readApiKey,
  storeApiKey,
} from '#core/utils/config'
import { fetchOllamaModels } from './fetchOllamaModels'
import type { ModelSelectorState } from './useModelSelectorState'
import type { ModelParamsField } from './viewTypes'

export function useModelSelectorModelFlow(state: ModelSelectorState) {
  const ENVIRONMENT_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
  const activeFetchIdRef = useRef(0)

  useEffect(
    () => () => {
      activeFetchIdRef.current += 1
    },
    [],
  )

  function parseCredentialInput(
    value: string,
  ):
    | { type: 'environment'; envVarName: string }
    | { type: 'session'; apiKey: string }
    | null {
    const input = value.trim()
    if (!input) {
      return state.apiKeyEnv
        ? { type: 'environment', envVarName: state.apiKeyEnv }
        : null
    }

    if (input.startsWith('env:')) {
      const envVarName = input.slice('env:'.length).trim()
      return ENVIRONMENT_VARIABLE_PATTERN.test(envVarName)
        ? { type: 'environment', envVarName }
        : null
    }

    if (input.startsWith('key:')) {
      const apiKey = input.slice('key:'.length).trim()
      return apiKey ? { type: 'session', apiKey } : null
    }

    return ENVIRONMENT_VARIABLE_PATTERN.test(input)
      ? { type: 'environment', envVarName: input }
      : { type: 'session', apiKey: input }
  }

  function summarizeErrorMessage(message: string): string {
    const normalized = message.replace(/\s+/g, ' ').trim()
    const htmlIndex = normalized.toLowerCase().indexOf('<html')
    const trimmed =
      htmlIndex >= 0 ? normalized.slice(0, htmlIndex).trim() : normalized
    if (!trimmed) return 'Unknown error'
    return trimmed.length > 240 ? `${trimmed.slice(0, 240)}…` : trimmed
  }

  async function fetchModels(isCurrent: () => boolean): Promise<ModelInfo[]> {
    const apiKey = readApiKey(state.apiKeyEnv) ?? ''
    if (!apiKey && state.selectedProvider !== 'ollama') {
      throw new Error(
        `No API key is available for '${state.apiKeyEnv || 'API_KEY'}'. Paste a key, set the variable, or press Enter to enter a model ID manually.`,
      )
    }

    return await fetchModelsForProvider({
      selectedProvider: state.selectedProvider,
      apiKey,
      providerBaseUrl: state.providerBaseUrl,
      customBaseUrl: state.customBaseUrl,
      modelFetchers,
      setIsLoadingModels: isLoading => {
        if (isCurrent()) state.setIsLoadingModels(isLoading)
      },
      setModelLoadError: error => {
        if (isCurrent()) state.setModelLoadError(error)
      },
      setAvailableModels: models => {
        if (isCurrent()) state.setAvailableModels(models)
      },
      navigateTo: screen => {
        if (isCurrent()) state.navigateTo(screen)
      },
    })
  }

  async function fetchModelsWithRetry(): Promise<ModelInfo[]> {
    const MAX_RETRIES = 2
    let lastError: Error | null = null
    const fetchId = activeFetchIdRef.current + 1
    activeFetchIdRef.current = fetchId
    const isCurrent = () => activeFetchIdRef.current === fetchId

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (!isCurrent()) return []
      state.setFetchRetryCount(attempt)
      state.setIsRetrying(attempt > 1)

      if (attempt > 1) {
        state.setModelLoadError(
          `Attempt ${attempt}/${MAX_RETRIES}: Retrying model discovery...`,
        )
        await new Promise(resolve => setTimeout(resolve, 1000))
        if (!isCurrent()) return []
      }

      try {
        const models = await fetchModels(isCurrent)
        if (!isCurrent()) return []
        state.setFetchRetryCount(0)
        state.setIsRetrying(false)
        state.setModelLoadError(null)
        return models
      } catch (error) {
        if (!isCurrent()) return []
        lastError = error instanceof Error ? error : new Error(String(error))
        debugLogger.warn('MODEL_FETCH_RETRY_FAILED', {
          attempt,
          maxRetries: MAX_RETRIES,
          error: lastError.message,
          provider: state.selectedProvider,
        })

        if (attempt === MAX_RETRIES) break
      }
    }

    if (!isCurrent()) return []
    state.setIsRetrying(false)
    const errorMessage = summarizeErrorMessage(lastError?.message || '')

    state.setModelLoadError(
      `Model discovery could not use the credential after ${MAX_RETRIES} attempts: ${errorMessage}`,
    )
    throw new Error(`Model discovery failed: ${errorMessage}`)
  }

  function cancelPendingModelFetch(): void {
    activeFetchIdRef.current += 1
    state.setFetchRetryCount(0)
    state.setIsRetrying(false)
    state.setIsLoadingModels(false)
  }

  async function handleApiKeySubmit(key: string) {
    const credential = parseCredentialInput(key)
    if (!credential) {
      state.setModelLoadError(
        'Paste an API key, or enter env:VARIABLE_NAME for an environment variable.',
      )
      return
    }

    if (credential.type === 'environment') {
      clearSessionApiKey(state.apiKeyEnv)
      clearSessionApiKey(credential.envVarName)
      state.setApiKeyEnv(credential.envVarName)
      state.setApiKeyInput(credential.envVarName)
      state.setHasStoredApiKey(false)
    } else {
      const envVarName =
        state.apiKeyEnv ?? getSuggestedApiKeyEnvVar(state.selectedProvider)
      if (!envVarName) {
        state.setModelLoadError('This provider does not accept an API key.')
        return
      }

      try {
        storeApiKey(envVarName, credential.apiKey)
      } catch {
        state.setModelLoadError(
          'Kode could not securely save this API key. Check the permissions of ~/.kode and retry.',
        )
        return
      }
      state.setApiKeyEnv(envVarName)
      state.setApiKeyInput(envVarName)
      state.setHasStoredApiKey(true)
    }

    state.setModelLoadError(null)
    state.navigateTo(
      state.selectedProvider === 'azure' ? 'resourceName' : 'modelInput',
    )
  }

  function handleResourceNameSubmit(name: string) {
    state.setResourceName(name)
    state.navigateTo('modelInput')
  }

  function handleCustomBaseUrlSubmit(url: string) {
    const cleanUrl = url.replace(/\/+$/, '')
    state.setCustomBaseUrl(cleanUrl)
    state.navigateTo('apiKey')
  }

  function handleProviderBaseUrlSubmit(url: string) {
    const cleanUrl = url.replace(/\/+$/, '')
    state.setProviderBaseUrl(cleanUrl)

    if (state.selectedProvider === 'ollama') {
      state.setOllamaBaseUrl(cleanUrl)
      state.setIsLoadingModels(true)
      state.setModelLoadError(null)

      fetchOllamaModels({
        ollamaBaseUrl: cleanUrl,
        setAvailableModels: state.setAvailableModels,
        setModelLoadError: state.setModelLoadError,
        navigateTo: () => state.navigateTo('model'),
      }).finally(() => {
        state.setIsLoadingModels(false)
      })
    } else {
      state.navigateTo('apiKey')
    }
  }

  function handleCustomModelSubmit(model: string) {
    state.setCustomModelName(model)
    state.setSelectedModel(model)
    state.setSupportsReasoningEffort(false)
    state.setSupportsMaxTokens(false)
    state.setSupportsContextLength(false)
    state.setReasoningEffort(null)

    state.setMaxTokensMode('preset')
    state.setSelectedMaxTokensPreset(DEFAULT_MAX_TOKENS)
    state.setMaxTokens(DEFAULT_MAX_TOKENS.toString())
    state.setMaxTokensCursorOffset(DEFAULT_MAX_TOKENS.toString().length)

    state.navigateTo('confirmation')
  }

  function handleModelSelection(model: string) {
    state.setSelectedModel(model)

    const modelInfo = state.availableModels.find(m => m.model === model)
    state.setSupportsReasoningEffort(
      Boolean(modelInfo?.supports_reasoning_effort),
    )

    if (!modelInfo?.supports_reasoning_effort) {
      state.setReasoningEffort(null)
    }

    const modelContextLength = modelInfo?.context_length
    const hasReportedContextLength =
      typeof modelContextLength === 'number' &&
      Number.isFinite(modelContextLength) &&
      modelContextLength > 0
    state.setSupportsContextLength(hasReportedContextLength)
    state.setContextLength(
      hasReportedContextLength
        ? (modelContextLength as number)
        : DEFAULT_CONTEXT_LENGTH,
    )

    const modelMaxTokens = modelInfo?.max_tokens
    const hasReportedMaxTokens =
      typeof modelMaxTokens === 'number' &&
      Number.isFinite(modelMaxTokens) &&
      modelMaxTokens > 0
    state.setSupportsMaxTokens(hasReportedMaxTokens)
    if (hasReportedMaxTokens) {
      const reportedMaxTokens = modelMaxTokens as number
      const matchingPreset = MAX_TOKENS_OPTIONS.find(
        option => option.value === reportedMaxTokens,
      )

      if (matchingPreset) {
        state.setMaxTokensMode('preset')
        state.setSelectedMaxTokensPreset(reportedMaxTokens)
        state.setMaxTokens(reportedMaxTokens.toString())
      } else {
        state.setMaxTokensMode('custom')
        state.setMaxTokens(reportedMaxTokens.toString())
      }
      state.setMaxTokensCursorOffset(reportedMaxTokens.toString().length)
    } else {
      state.setMaxTokensMode('preset')
      state.setSelectedMaxTokensPreset(DEFAULT_MAX_TOKENS)
      state.setMaxTokens(DEFAULT_MAX_TOKENS.toString())
      state.setMaxTokensCursorOffset(DEFAULT_MAX_TOKENS.toString().length)
    }

    state.navigateTo('confirmation')
  }

  const handleModelParamsSubmit = () => {
    state.navigateTo(
      state.supportsContextLength ? 'contextLength' : 'confirmation',
    )
  }

  const getFormFieldsForModelParams = (): ModelParamsField[] => {
    const fields: ModelParamsField[] = []

    if (state.supportsMaxTokens) {
      fields.push({
        name: 'maxTokens',
        label: 'Maximum output (tokens)',
        description:
          'Upper limit for one response. The provider can enforce a lower limit.',
        component: 'select',
        options: MAX_TOKENS_OPTIONS.map(option => ({
          label: option.label,
          value: option.value.toString(),
        })),
        defaultValue: state.maxTokens,
      })
    }

    if (state.supportsReasoningEffort) {
      fields.push({
        name: 'reasoningEffort',
        label: 'Reasoning Effort',
        description: 'Controls reasoning depth for complex problems.',
        component: 'select',
      })
    }

    fields.push({
      name: 'submit',
      label: 'Review setup →',
      component: 'button',
    })
    return fields
  }

  const reasoningEffortOptions = getReasoningEffortOptions(state.selectedModel)
  const requestStrategyOptions = REQUEST_STRATEGY_OPTIONS
  const handleContextLengthSubmit = () =>
    state.navigateTo(state.isEditing ? 'confirmation' : 'connectionTest')

  return {
    fetchModelsWithRetry,
    cancelPendingModelFetch,
    handleApiKeySubmit,
    handleResourceNameSubmit,
    handleCustomBaseUrlSubmit,
    handleProviderBaseUrlSubmit,
    handleCustomModelSubmit,
    handleModelSelection,
    handleModelParamsSubmit,
    getFormFieldsForModelParams,
    reasoningEffortOptions,
    requestStrategyOptions,
    handleContextLengthSubmit,
  }
}

export type ModelSelectorModelFlow = ReturnType<
  typeof useModelSelectorModelFlow
>
