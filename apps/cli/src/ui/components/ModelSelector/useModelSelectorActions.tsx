import {
  getSuggestedApiKeyEnvVar,
  providerUsesApiKey,
  readApiKeyFromEnvironment,
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
    if (
      providerUsesApiKey(state.selectedProvider) &&
      !readApiKeyFromEnvironment(apiKeyEnv)
    ) {
      state.setValidationError(
        `This model was not saved because ${apiKeyEnv ?? 'the provider API key environment variable'} is not set. ` +
          'Set it in the current environment, then retry. Rotate any API key previously stored in configuration.',
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
      state.setApiKeyEdited(false)
      state.setApiKeyEnv(getSuggestedApiKeyEnvVar(provider))
      state.setApiKey('')
      state.setCursorOffset(0)
      state.setApiKeyCleanedNotification(false)
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

  async function handleConnectionTest() {
    state.setIsTestingConnection(true)
    state.setConnectionTestResult(null)

    try {
      const result = await runConnectionTestFlow({
        params: {
          selectedProvider: state.selectedProvider,
          selectedModel: state.selectedModel,
          apiKey: state.apiKey,
          maxTokens: state.maxTokens,
          providerBaseUrl: state.providerBaseUrl,
          customBaseUrl: state.customBaseUrl,
          resourceName: state.resourceName,
          requestStrategy: state.requestStrategy,
        },
        navigateTo: () => state.navigateTo('confirmation'),
        onProgress: progress => state.setConnectionTestResult(progress),
      })
      state.setConnectionTestResult(result)
    } finally {
      state.setIsTestingConnection(false)
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
