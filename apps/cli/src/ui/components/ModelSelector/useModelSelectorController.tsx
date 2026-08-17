import { useMemo } from 'react'
import { getTheme } from '#core/utils/theme'
import { useExitOnCtrlCD } from '#ui-ink/hooks/useExitOnCtrlCD'
import { useCliExit } from '#ui-ink/hooks/useCliExit'
import { useScreenLayout } from '#ui-ink/primitives/layout/useScreenLayout'
import { printModelConfig } from './flow/printModelConfig'
import type { ModelSelectorProps } from './types'
import type { ModelSelectorViewProps } from './viewTypes'
import { useModelSelectorInput } from './useModelSelectorInput'
import { useModelSelectorMenus } from './useModelSelectorMenus'
import { useModelSelectorModelOptions } from './useModelSelectorModelOptions'
import { useModelSelectorState } from './useModelSelectorState'
import { useModelSelectorActions } from './useModelSelectorActions'
import { useEscapeNavigation } from './flow/useEscapeNavigation'

function clampOptionIndex(next: number, length: number): number {
  if (length <= 0) return 0
  return Math.max(0, Math.min(next, length - 1))
}

function getWheelDelta(direction: 'up' | 'down'): number {
  return direction === 'down' ? 1 : -1
}

export function useModelSelectorController(
  props: ModelSelectorProps,
): ModelSelectorViewProps {
  const theme = getTheme()
  const layout = useScreenLayout({ compactColumns: 76 })
  const terminalRows = layout.rows
  const terminalColumns = layout.columns
  const tightLayout = layout.tightLayout
  const compactLayout = layout.compactLayout
  const containerPaddingY = layout.paddingY
  const containerGap = layout.gap

  const requestExit = useCliExit()
  const exitState = useExitOnCtrlCD(() => requestExit(0))
  const exitStateForScreens = useMemo(
    () => ({ pending: exitState.pending, keyName: exitState.keyName ?? '' }),
    [exitState.pending, exitState.keyName],
  )

  const onDone = () => {
    printModelConfig()
    props.onDone()
  }

  const menus = useModelSelectorMenus({
    containerPaddingY,
    containerGap,
  })

  const state = useModelSelectorState({
    skipModelType: props.skipModelType ?? false,
    initialModelProfile: props.initialModelProfile,
    initialProvider: props.initialProvider,
    providerOptionCount: menus.mainMenuOptions.length,
    partnerProviderOptionCount: menus.partnerProviderOptions.length,
    codingPlanOptionCount: menus.codingPlanOptions.length,
  })

  const { modelOptions } = useModelSelectorModelOptions({
    selectedProvider: state.selectedProvider,
    availableModels: state.availableModels,
    modelSearchQuery: state.modelSearchQuery,
  })
  const actions = useModelSelectorActions({ props, state, onDone })

  useEscapeNavigation(actions.handleBack, props.abortController)

  const onProviderOptionPress = (optionIndex: number) => {
    const nextIndex = clampOptionIndex(
      optionIndex,
      menus.mainMenuOptions.length,
    )
    const opt = menus.mainMenuOptions[nextIndex]
    if (!opt) return

    state.setProviderFocusIndex(nextIndex)
    void actions.handleProviderSelection(opt.value)
  }

  const onProviderOptionWheel = (direction: 'up' | 'down') => {
    state.setProviderFocusIndex(prev =>
      clampOptionIndex(
        prev + getWheelDelta(direction),
        menus.mainMenuOptions.length,
      ),
    )
  }

  const onPartnerProviderOptionPress = (optionIndex: number) => {
    const nextIndex = clampOptionIndex(
      optionIndex,
      menus.partnerProviderOptions.length,
    )
    const opt = menus.partnerProviderOptions[nextIndex]
    if (!opt) return

    state.setPartnerProviderFocusIndex(nextIndex)
    void actions.handleProviderSelection(opt.value)
  }

  const onPartnerProviderOptionWheel = (direction: 'up' | 'down') => {
    state.setPartnerProviderFocusIndex(prev =>
      clampOptionIndex(
        prev + getWheelDelta(direction),
        menus.partnerProviderOptions.length,
      ),
    )
  }

  const onCodingPlanOptionPress = (optionIndex: number) => {
    const nextIndex = clampOptionIndex(
      optionIndex,
      menus.codingPlanOptions.length,
    )
    const opt = menus.codingPlanOptions[nextIndex]
    if (!opt) return

    state.setCodingPlanFocusIndex(nextIndex)
    void actions.handleProviderSelection(opt.value)
  }

  const onCodingPlanOptionWheel = (direction: 'up' | 'down') => {
    state.setCodingPlanFocusIndex(prev =>
      clampOptionIndex(
        prev + getWheelDelta(direction),
        menus.codingPlanOptions.length,
      ),
    )
  }

  useModelSelectorInput({
    currentScreen: state.currentScreen,
    mainMenuOptions: menus.mainMenuOptions,
    providerFocusIndex: state.providerFocusIndex,
    setProviderFocusIndex: state.setProviderFocusIndex,
    partnerProviderOptions: menus.partnerProviderOptions,
    partnerProviderFocusIndex: state.partnerProviderFocusIndex,
    setPartnerProviderFocusIndex: state.setPartnerProviderFocusIndex,
    codingPlanOptions: menus.codingPlanOptions,
    codingPlanFocusIndex: state.codingPlanFocusIndex,
    setCodingPlanFocusIndex: state.setCodingPlanFocusIndex,
    selectedProvider: state.selectedProvider,
    apiKey: state.apiKeyInput,
    resourceName: state.resourceName,
    providerBaseUrl: state.providerBaseUrl,
    customBaseUrl: state.customBaseUrl,
    customModelName: state.customModelName,
    contextLength: state.contextLength,
    contextLengthOptions: state.contextLengthOptions,
    setContextLength: state.setContextLength,
    isTestingConnection: state.isTestingConnection,
    connectionTestResult: state.connectionTestResult,
    activeFieldIndex: state.activeFieldIndex,
    setActiveFieldIndex: state.setActiveFieldIndex,
    handleProviderSelection: actions.handleProviderSelection,
    handleApiKeySubmit: actions.handleApiKeySubmit,
    fetchModelsWithRetry: actions.fetchModelsWithRetry,
    navigateTo: state.navigateTo,
    handleResourceNameSubmit: actions.handleResourceNameSubmit,
    handleCustomBaseUrlSubmit: actions.handleCustomBaseUrlSubmit,
    handleProviderBaseUrlSubmit: actions.handleProviderBaseUrlSubmit,
    handleCustomModelSubmit: actions.handleCustomModelSubmit,
    handleConfirmation: actions.handleConfirmation,
    activateAsMain: state.activateAsMain,
    setActivateAsMain: state.setActivateAsMain,
    setValidationError: state.setValidationError,
    handleConnectionTest: actions.handleConnectionTest,
    handleContextLengthSubmit: actions.handleContextLengthSubmit,
    setModelLoadError: state.setModelLoadError,
    getFormFieldsForModelParams: actions.getFormFieldsForModelParams,
    handleModelParamsSubmit: actions.handleModelParamsSubmit,
  })

  return {
    theme,
    exitState: exitStateForScreens,
    terminalRows,
    terminalColumns,
    compactLayout,
    tightLayout,
    containerPaddingY,
    containerGap,
    currentScreen: state.currentScreen,
    selectedProvider: state.selectedProvider,
    selectedModel: state.selectedModel,
    apiKeyEnv: state.apiKeyEnv,
    apiKey: state.apiKeyInput,
    hasStoredApiKey: state.hasStoredApiKey,
    cursorOffset: state.cursorOffset,
    handleApiKeyChange: actions.handleApiKeyChange,
    handleApiKeySubmit: actions.handleApiKeySubmit,
    handleCursorOffsetChange: actions.handleCursorOffsetChange,
    isLoadingModels: state.isLoadingModels,
    modelLoadError: state.modelLoadError,
    providerBaseUrl: state.providerBaseUrl,
    setProviderBaseUrl: state.setProviderBaseUrl,
    providerBaseUrlCursorOffset: state.providerBaseUrlCursorOffset,
    setProviderBaseUrlCursorOffset: state.setProviderBaseUrlCursorOffset,
    customBaseUrl: state.customBaseUrl,
    setCustomBaseUrl: state.setCustomBaseUrl,
    customBaseUrlCursorOffset: state.customBaseUrlCursorOffset,
    setCustomBaseUrlCursorOffset: state.setCustomBaseUrlCursorOffset,
    customModelName: state.customModelName,
    setCustomModelName: state.setCustomModelName,
    customModelNameCursorOffset: state.customModelNameCursorOffset,
    setCustomModelNameCursorOffset: state.setCustomModelNameCursorOffset,
    resourceName: state.resourceName,
    setResourceName: state.setResourceName,
    resourceNameCursorOffset: state.resourceNameCursorOffset,
    setResourceNameCursorOffset: state.setResourceNameCursorOffset,
    availableModels: state.availableModels,
    modelSearchQuery: state.modelSearchQuery,
    modelSearchCursorOffset: state.modelSearchCursorOffset,
    handleModelSearchChange: actions.handleModelSearchChange,
    handleModelSearchCursorOffsetChange:
      actions.handleModelSearchCursorOffsetChange,
    modelOptions,
    handleResourceNameSubmit: actions.handleResourceNameSubmit,
    handleCustomBaseUrlSubmit: actions.handleCustomBaseUrlSubmit,
    handleProviderBaseUrlSubmit: actions.handleProviderBaseUrlSubmit,
    handleCustomModelSubmit: actions.handleCustomModelSubmit,
    handleModelSelection: actions.handleModelSelection,
    handleModelParamsSubmit: actions.handleModelParamsSubmit,
    maxTokens: state.maxTokens,
    setMaxTokens: state.setMaxTokens,
    setSelectedMaxTokensPreset: state.setSelectedMaxTokensPreset,
    setMaxTokensCursorOffset: state.setMaxTokensCursorOffset,
    supportsReasoningEffort: state.supportsReasoningEffort,
    reasoningEffortOptions: actions.reasoningEffortOptions,
    reasoningEffort: state.reasoningEffort,
    setReasoningEffort: state.setReasoningEffort,
    requestStrategy: state.requestStrategy,
    requestStrategyOptions: actions.requestStrategyOptions,
    setRequestStrategy: state.setRequestStrategy,
    activateAsMain: state.activateAsMain,
    contextLength: state.contextLength,
    contextLengthOptions: state.contextLengthOptions,
    isTestingConnection: state.isTestingConnection,
    connectionTestResult: state.connectionTestResult,
    validationError: state.validationError,
    ollamaBaseUrl: state.ollamaBaseUrl,
    activeFieldIndex: state.activeFieldIndex,
    setActiveFieldIndex: state.setActiveFieldIndex,
    getFormFieldsForModelParams: actions.getFormFieldsForModelParams,
    mainMenuOptions: menus.mainMenuOptions,
    providerFocusIndex: state.providerFocusIndex,
    providerReservedLines: menus.providerReservedLines,
    onProviderOptionPress,
    onProviderOptionWheel,
    partnerProviderOptions: menus.partnerProviderOptions,
    partnerProviderFocusIndex: state.partnerProviderFocusIndex,
    partnerReservedLines: menus.partnerReservedLines,
    onPartnerProviderOptionPress,
    onPartnerProviderOptionWheel,
    codingPlanOptions: menus.codingPlanOptions,
    codingPlanFocusIndex: state.codingPlanFocusIndex,
    codingReservedLines: menus.codingReservedLines,
    onCodingPlanOptionPress,
    onCodingPlanOptionWheel,
    getProviderLabel: menus.getProviderLabel,
  }
}
