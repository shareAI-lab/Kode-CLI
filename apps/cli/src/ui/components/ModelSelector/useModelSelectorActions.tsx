import { useEffect, useRef } from 'react'
import {
  clearSessionApiKey,
  getSuggestedApiKeyEnvVar,
  providerUsesApiKey,
  readApiKey,
  type ProviderType,
} from '#core/utils/config'
import { logError } from '#core/utils/log'
import { runConnectionTestFlow } from './flow/actions/connectionTest'
import { handleProviderSelection as handleProviderSelectionAction } from './flow/actions/providerSelection'
import {
  applyPointersForNewModel,
  saveModelConfiguration,
} from './flow/actions/saveConfiguration'
import { handleBackNavigation } from './flow/state'
import type { ModelSelectorProps } from './types'
import type { ModelSelectorState } from './useModelSelectorState'
import { useModelSelectorModelFlow } from './useModelSelectorModelFlow'
import { useModelSelectorTextHandlers } from './useModelSelectorTextHandlers'

type Args = {
  props: ModelSelectorProps
  state: ModelSelectorState
  onDone: () => void
}

export function useModelSelectorActions({ props, state, onDone }: Args) {
  const modelFlow = useModelSelectorModelFlow(state)
  const textHandlers = useModelSelectorTextHandlers(state)
  const activeConnectionTestIdRef = useRef(0)

  useEffect(
    () => () => {
      activeConnectionTestIdRef.current += 1
    },
    [],
  )

  async function saveConfiguration(
    provider: ProviderType,
    model: string,
  ): Promise<string | null> {
    try {
      return await saveModelConfiguration({
        provider,
        model,
        providerBaseUrl: state.providerBaseUrl,
        resourceName: state.resourceName,
        customBaseUrl: state.customBaseUrl,
        apiKeyEnv: state.apiKeyEnv,
        maxTokens: state.maxTokens,
        contextLength: state.contextLength,
        reasoningEffort: state.reasoningEffort ?? undefined,
        requestStrategy: state.requestStrategy,
        activateAsMain: state.activateAsMain,
      })
    } catch (error) {
      state.setValidationError(
        error instanceof Error ? error.message : 'Failed to add model',
      )
      return null
    }
  }

  async function handleConfirmation(): Promise<void> {
    state.setValidationError(null)

    const apiKeyEnv =
      state.apiKeyEnv ?? getSuggestedApiKeyEnvVar(state.selectedProvider)
    if (providerUsesApiKey(state.selectedProvider) && !readApiKey(apiKeyEnv)) {
      state.setValidationError(
        `This model was not saved because no credential is available for ${apiKeyEnv ?? 'this provider'}. ` +
          'Paste a key or set the environment variable, then retry.',
      )
      return
    }

    const modelId = await saveConfiguration(
      state.selectedProvider,
      state.selectedModel,
    )
    if (!modelId) return

    if (props.initialModelProfile) {
      onDone()
      return
    }

    try {
      applyPointersForNewModel({
        modelId,
        isOnboarding: Boolean(props.isOnboarding),
        targetPointer: props.targetPointer,
        activateAsMain: state.activateAsMain,
      })
    } catch (error) {
      state.setValidationError(
        error instanceof Error
          ? error.message
          : 'Failed to update model pointers',
      )
      return
    }

    onDone()
  }

  const handleBack = () => {
    modelFlow.cancelPendingModelFetch()
    cancelPendingConnectionTest()
    const { stack: nextStack, effect } = handleBackNavigation(state.screenStack)

    if (effect?.type === 'resetProviderFocus') {
      state.setProviderFocusIndex(0)
    }

    if (effect?.type === 'exit') {
      if (props.onCancel) props.onCancel()
      else onDone()
      return
    }

    if (nextStack !== state.screenStack) {
      state.setScreenStack(nextStack)
    }
  }

  async function handleProviderSelection(provider: string) {
    const isProviderMenu =
      provider === 'partnerProviders' || provider === 'partnerCodingPlans'

    if (!isProviderMenu) {
      clearSessionApiKey(state.apiKeyEnv)
      const apiKeyEnv = getSuggestedApiKeyEnvVar(provider)
      state.setApiKeyEdited(false)
      state.setApiKeyEnv(apiKeyEnv)
      state.setApiKeyInput('')
      state.setHasStoredApiKey(false)
      state.setCursorOffset(0)
      state.setModelLoadError(null)
      state.setAvailableModels([])
      state.setSelectedModel('')
      state.setValidationError(null)
    }

    try {
      await handleProviderSelectionAction(provider, {
        navigateTo: state.navigateTo,
        setPartnerProviderFocusIndex: state.setPartnerProviderFocusIndex,
        setCodingPlanFocusIndex: state.setCodingPlanFocusIndex,
        setSelectedProvider: state.setSelectedProvider,
        setProviderBaseUrl: state.setProviderBaseUrl,
        saveConfiguration,
        onDone,
        selectedModel: state.selectedModel,
      })
    } catch (error) {
      logError(error)
      state.setValidationError(
        error instanceof Error ? error.message : 'Failed to select provider',
      )
    }
  }

  function cancelPendingConnectionTest(): void {
    activeConnectionTestIdRef.current += 1
    state.setIsTestingConnection(false)
  }

  async function handleConnectionTest() {
    const testId = activeConnectionTestIdRef.current + 1
    activeConnectionTestIdRef.current = testId
    const isCurrent = () => activeConnectionTestIdRef.current === testId

    state.setIsTestingConnection(true)
    state.setConnectionTestResult(null)

    try {
      const result = await runConnectionTestFlow({
        params: {
          selectedProvider: state.selectedProvider,
          selectedModel: state.selectedModel,
          apiKey: readApiKey(state.apiKeyEnv) ?? '',
          maxTokens: state.maxTokens,
          providerBaseUrl: state.providerBaseUrl,
          customBaseUrl: state.customBaseUrl,
          resourceName: state.resourceName,
          requestStrategy: state.requestStrategy,
        },
        navigateTo: () => {
          if (isCurrent()) state.navigateTo('confirmation')
        },
        onProgress: progress => {
          if (isCurrent()) state.setConnectionTestResult(progress)
        },
      })
      if (isCurrent()) state.setConnectionTestResult(result)
    } finally {
      if (isCurrent()) state.setIsTestingConnection(false)
    }
  }

  return {
    handleBack,
    handleProviderSelection,
    ...modelFlow,
    handleConnectionTest,
    handleConfirmation,
    ...textHandlers,
  }
}

export type ModelSelectorActions = ReturnType<typeof useModelSelectorActions>
