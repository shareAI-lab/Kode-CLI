import { useMemo, useState } from 'react'
import {
  getSuggestedApiKeyEnvVar,
  getGlobalConfig,
  type ModelProfile,
  type ProviderType,
} from '#core/utils/config'
import { useScopedIndexState } from '#ui-ink/hooks/useScopedIndexState'
import type { ConnectionTestResult } from './flow/actions/connectionTest'
import {
  CONTEXT_LENGTH_OPTIONS,
  DEFAULT_CONTEXT_LENGTH,
  DEFAULT_MAX_TOKENS,
  MAX_TOKENS_OPTIONS,
  type ReasoningEffortOption,
  type RequestStrategyOption,
} from './flow/options'
import {
  createInitialScreenStack,
  getCurrentScreen,
  pushScreen,
  type ModelSelectorScreen,
} from './flow/state'
import type { ModelInfo } from './flow/types'

export function useModelSelectorState(opts: {
  skipModelType: boolean
  initialModelProfile?: ModelProfile
  initialProvider?: ProviderType
  focusScope?: string
  providerOptionCount?: number
  partnerProviderOptionCount?: number
  codingPlanOptionCount?: number
}) {
  const config = getGlobalConfig()
  const initialModelProfile = opts.initialModelProfile
  const initialMaxTokens =
    initialModelProfile?.maxTokens ?? config.maxTokens ?? DEFAULT_MAX_TOKENS
  const initialContextLength =
    initialModelProfile?.contextLength ?? DEFAULT_CONTEXT_LENGTH
  const initialMaxTokensMode = MAX_TOKENS_OPTIONS.some(
    option => option.value === initialMaxTokens,
  )
    ? 'preset'
    : 'custom'

  const [screenStack, setScreenStack] = useState<ModelSelectorScreen[]>(() =>
    initialModelProfile
      ? ['modelParams']
      : opts.initialProvider
        ? ['apiKey']
        : createInitialScreenStack({ skipModelType: opts.skipModelType }),
  )

  const currentScreen = getCurrentScreen(screenStack)
  const navigateTo = (screen: ModelSelectorScreen) => {
    setScreenStack(prev => pushScreen(prev, screen))
  }

  const [selectedProvider, setSelectedProvider] = useState<ProviderType>(
    initialModelProfile?.provider ??
      opts.initialProvider ??
      config.primaryProvider ??
      'anthropic',
  )
  const [selectedModel, setSelectedModel] = useState<string>(
    initialModelProfile?.modelName ?? '',
  )
  const [apiKeyEnv, setApiKeyEnv] = useState<string | undefined>(
    initialModelProfile?.apiKeyEnv ??
      getSuggestedApiKeyEnvVar(
        initialModelProfile?.provider ??
          opts.initialProvider ??
          config.primaryProvider ??
          'anthropic',
      ),
  )
  const [apiKey, setApiKey] = useState<string>('')

  const [maxTokens, setMaxTokens] = useState<string>(
    initialMaxTokens.toString(),
  )
  const [maxTokensMode, setMaxTokensMode] = useState<'preset' | 'custom'>(
    initialMaxTokensMode,
  )
  const [selectedMaxTokensPreset, setSelectedMaxTokensPreset] =
    useState<number>(initialMaxTokens)
  const [reasoningEffort, setReasoningEffort] =
    useState<ReasoningEffortOption | null>(
      (initialModelProfile?.reasoningEffort as ReasoningEffortOption) ??
        'medium',
    )
  const [supportsReasoningEffort, setSupportsReasoningEffort] =
    useState<boolean>(Boolean(initialModelProfile?.reasoningEffort))

  const [contextLength, setContextLength] =
    useState<number>(initialContextLength)
  const contextLengthOptions = useMemo(() => {
    if (CONTEXT_LENGTH_OPTIONS.some(opt => opt.value === contextLength)) {
      return CONTEXT_LENGTH_OPTIONS
    }

    return [
      ...CONTEXT_LENGTH_OPTIONS,
      {
        label: `${contextLength.toLocaleString()} tokens (current)`,
        value: contextLength,
      },
    ].sort((a, b) => a.value - b.value)
  }, [contextLength])

  const [requestStrategy, setRequestStrategy] = useState<RequestStrategyOption>(
    (initialModelProfile?.requestStrategy as RequestStrategyOption) ?? 'auto',
  )

  const [activeFieldIndex, setActiveFieldIndex] = useState(0)
  const [maxTokensCursorOffset, setMaxTokensCursorOffset] = useState<number>(
    initialMaxTokens.toString().length,
  )

  const [apiKeyCleanedNotification, setApiKeyCleanedNotification] =
    useState<boolean>(false)

  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([])
  const [isLoadingModels, setIsLoadingModels] = useState(false)
  const [modelLoadError, setModelLoadError] = useState<string | null>(null)
  const [modelSearchQuery, setModelSearchQuery] = useState<string>('')
  const [modelSearchCursorOffset, setModelSearchCursorOffset] =
    useState<number>(0)
  const [cursorOffset, setCursorOffset] = useState<number>(0)
  const [apiKeyEdited, setApiKeyEdited] = useState<boolean>(false)

  const focusScope =
    opts.focusScope ??
    `model-selector:${initialModelProfile?.provider ?? 'new'}:${initialModelProfile?.modelName ?? 'new'}`
  const [providerFocusIndex, setProviderFocusIndex] = useScopedIndexState({
    scope: `${focusScope}:provider`,
    itemCount: Math.max(1, opts.providerOptionCount ?? 1),
  })
  const [partnerProviderFocusIndex, setPartnerProviderFocusIndex] =
    useScopedIndexState({
      scope: `${focusScope}:partner-provider`,
      itemCount: Math.max(1, opts.partnerProviderOptionCount ?? 1),
    })
  const [codingPlanFocusIndex, setCodingPlanFocusIndex] = useScopedIndexState({
    scope: `${focusScope}:coding-plan`,
    itemCount: Math.max(1, opts.codingPlanOptionCount ?? 1),
  })

  const [fetchRetryCount, setFetchRetryCount] = useState<number>(0)
  const [isRetrying, setIsRetrying] = useState<boolean>(false)

  const [isTestingConnection, setIsTestingConnection] = useState<boolean>(false)
  const [connectionTestResult, setConnectionTestResult] =
    useState<ConnectionTestResult | null>(null)

  const [validationError, setValidationError] = useState<string | null>(null)

  const [resourceName, setResourceName] = useState<string>('')
  const [resourceNameCursorOffset, setResourceNameCursorOffset] =
    useState<number>(0)
  const [customModelName, setCustomModelName] = useState<string>(
    initialModelProfile?.modelName ?? '',
  )
  const [customModelNameCursorOffset, setCustomModelNameCursorOffset] =
    useState<number>(initialModelProfile?.modelName?.length ?? 0)

  const [ollamaBaseUrl, setOllamaBaseUrl] = useState<string>(
    initialModelProfile?.provider === 'ollama' && initialModelProfile.baseURL
      ? initialModelProfile.baseURL
      : 'http://localhost:11434/v1',
  )

  const [customBaseUrl, setCustomBaseUrl] = useState<string>(
    initialModelProfile?.provider === 'custom-openai'
      ? initialModelProfile.baseURL || ''
      : '',
  )
  const [customBaseUrlCursorOffset, setCustomBaseUrlCursorOffset] =
    useState<number>(customBaseUrl.length)

  const [providerBaseUrl, setProviderBaseUrl] = useState<string>(
    initialModelProfile?.baseURL ?? '',
  )
  const [providerBaseUrlCursorOffset, setProviderBaseUrlCursorOffset] =
    useState<number>(providerBaseUrl.length)

  return {
    isEditing: Boolean(initialModelProfile),
    screenStack,
    setScreenStack,
    currentScreen,
    navigateTo,
    selectedProvider,
    setSelectedProvider,
    selectedModel,
    setSelectedModel,
    apiKeyEnv,
    setApiKeyEnv,
    apiKey,
    setApiKey,
    maxTokens,
    setMaxTokens,
    maxTokensMode,
    setMaxTokensMode,
    selectedMaxTokensPreset,
    setSelectedMaxTokensPreset,
    reasoningEffort,
    setReasoningEffort,
    supportsReasoningEffort,
    setSupportsReasoningEffort,
    contextLength,
    contextLengthOptions,
    setContextLength,
    requestStrategy,
    setRequestStrategy,
    activeFieldIndex,
    setActiveFieldIndex,
    maxTokensCursorOffset,
    setMaxTokensCursorOffset,
    apiKeyCleanedNotification,
    setApiKeyCleanedNotification,
    availableModels,
    setAvailableModels,
    isLoadingModels,
    setIsLoadingModels,
    modelLoadError,
    setModelLoadError,
    modelSearchQuery,
    setModelSearchQuery,
    modelSearchCursorOffset,
    setModelSearchCursorOffset,
    cursorOffset,
    setCursorOffset,
    apiKeyEdited,
    setApiKeyEdited,
    providerFocusIndex,
    setProviderFocusIndex,
    partnerProviderFocusIndex,
    setPartnerProviderFocusIndex,
    codingPlanFocusIndex,
    setCodingPlanFocusIndex,
    fetchRetryCount,
    setFetchRetryCount,
    isRetrying,
    setIsRetrying,
    isTestingConnection,
    setIsTestingConnection,
    connectionTestResult,
    setConnectionTestResult,
    validationError,
    setValidationError,
    resourceName,
    setResourceName,
    resourceNameCursorOffset,
    setResourceNameCursorOffset,
    customModelName,
    setCustomModelName,
    customModelNameCursorOffset,
    setCustomModelNameCursorOffset,
    ollamaBaseUrl,
    setOllamaBaseUrl,
    customBaseUrl,
    setCustomBaseUrl,
    customBaseUrlCursorOffset,
    setCustomBaseUrlCursorOffset,
    providerBaseUrl,
    setProviderBaseUrl,
    providerBaseUrlCursorOffset,
    setProviderBaseUrlCursorOffset,
  }
}

export type ModelSelectorState = ReturnType<typeof useModelSelectorState>
