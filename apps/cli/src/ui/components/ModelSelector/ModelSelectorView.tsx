import * as React from 'react'
import { Box, Text, type DOMElement } from 'ink'
import figures from 'figures'
import { ApiKeyScreen } from './flow/screens/ApiKeyScreen'
import { BaseUrlScreen } from './flow/screens/BaseUrlScreen'
import { ConfirmationScreen } from './flow/screens/ConfirmationScreen'
import { ConnectionTestScreen } from './flow/screens/ConnectionTestScreen'
import { ContextLengthScreen } from './flow/screens/ContextLengthScreen'
import { ModelInputScreen } from './flow/screens/ModelInputScreen'
import { ModelParamsScreen } from './flow/screens/ModelParamsScreen'
import { ModelSelectionScreen } from './flow/screens/ModelSelectionScreen'
import { PartnerCodingPlansScreen } from './flow/screens/PartnerCodingPlansScreen'
import { PartnerProvidersScreen } from './flow/screens/PartnerProvidersScreen'
import { ProviderSelectionScreen } from './flow/screens/ProviderSelectionScreen'
import { ResourceNameScreen } from './flow/screens/ResourceNameScreen'
import type {
  ModelSelectorViewProps,
  Option,
  WindowedOptionInteractions,
} from './viewTypes'
import { PressableRow } from '#ui-ink/primitives/list/PressableRow'
import { useMouseWheel } from '#ui-ink/hooks/useMouse'

type WindowedOptionsLayout = {
  visibleOptionCount: number
  showIndicators: boolean
}

function WindowedOptionsList({
  options,
  focusedIndex,
  layout,
  theme,
  interactions,
}: {
  options: Option[]
  focusedIndex: number
  layout: WindowedOptionsLayout
  theme: ModelSelectorViewProps['theme']
  interactions?: WindowedOptionInteractions
}): React.ReactNode {
  const ref = React.useRef<DOMElement | null>(null)

  useMouseWheel(
    ref,
    direction => {
      interactions?.onWheel?.(direction)
    },
    { isActive: interactions?.onWheel !== undefined, priority: 25 },
  )

  if (options.length === 0) {
    return <Text color={theme.secondaryText}>No options available.</Text>
  }

  const visibleCount = Math.max(
    1,
    Math.min(layout.visibleOptionCount, options.length),
  )
  const clampedFocus =
    options.length === 0
      ? 0
      : Math.max(0, Math.min(focusedIndex, options.length - 1))
  const half = Math.floor(visibleCount / 2)
  const start = Math.max(
    0,
    Math.min(clampedFocus - half, Math.max(0, options.length - visibleCount)),
  )
  const end = Math.min(options.length, start + visibleCount)
  const showUp = layout.showIndicators && start > 0
  const showDown = layout.showIndicators && end < options.length

  const visibleOptions = options.slice(start, end)
  const missingRows = Math.max(0, visibleCount - visibleOptions.length)

  return (
    <Box ref={ref} flexDirection="column" gap={0}>
      {layout.showIndicators ? (
        <Text color={theme.secondaryText}>
          {showUp ? `${figures.arrowUp} More` : ' '}
        </Text>
      ) : null}
      {visibleOptions.map((opt, idx) => {
        const absoluteIndex = start + idx
        const isFocused = absoluteIndex === focusedIndex
        return (
          <PressableRow
            key={opt.value}
            flexDirection="row"
            onPress={() => interactions?.onOptionPress?.(absoluteIndex)}
          >
            <Text color={isFocused ? theme.kode : theme.secondaryText}>
              {isFocused ? figures.pointer : ' '}
            </Text>
            <Text
              color={isFocused ? theme.text : theme.secondaryText}
              bold={isFocused}
              wrap="truncate-end"
            >
              {' '}
              {opt.label}
            </Text>
          </PressableRow>
        )
      })}
      {missingRows > 0
        ? Array.from({ length: missingRows }).map((_, idx) => (
            <Box key={`empty-${idx}`} flexDirection="row">
              <Text> </Text>
            </Box>
          ))
        : null}
      {layout.showIndicators ? (
        <Text color={theme.secondaryText}>
          {showDown ? `${figures.arrowDown} More` : ' '}
        </Text>
      ) : null}
    </Box>
  )
}

export function ModelSelectorView(
  props: ModelSelectorViewProps,
): React.ReactNode {
  const VIEWPORT_SAFE_MARGIN_ROWS = 2

  function getWindowedOptionsLayout(
    requestedCount: number,
    optionLength: number,
    reservedLines: number = 10,
  ): WindowedOptionsLayout {
    const rows = props.terminalRows
    // Keep spare rows to avoid Ink terminal-scroll tearing when the UI is near full-height.
    // 1 row is often not enough across terminals (prompt, IME, and line-wrap quirks), so we
    // use 2 as a conservative default.
    const maxListLines = Math.max(
      1,
      rows - reservedLines - VIEWPORT_SAFE_MARGIN_ROWS,
    )

    const canShowIndicators = maxListLines >= 3

    // Reserve 2 rows for stable up/down indicators whenever we have enough room.
    // This keeps list layout consistent across sub-screens.
    const indicatorReserve = canShowIndicators ? 2 : 0

    const visibleOptionCount = Math.max(
      1,
      Math.min(requestedCount, optionLength, maxListLines - indicatorReserve),
    )

    return {
      visibleOptionCount,
      // Always render indicator rows when we reserved space; show arrows only when truncated.
      showIndicators: indicatorReserve === 2,
    }
  }

  function renderWindowedOptions(
    options: Option[],
    focusedIndex: number,
    layout: WindowedOptionsLayout,
    interactions?: WindowedOptionInteractions,
  ) {
    return (
      <WindowedOptionsList
        options={options}
        focusedIndex={focusedIndex}
        layout={layout}
        theme={props.theme}
        interactions={interactions}
      />
    )
  }

  const minHeight = Math.max(1, props.terminalRows)
  const screen = (() => {
    if (props.currentScreen === 'apiKey') {
      return (
        <ApiKeyScreen
          theme={props.theme}
          exitState={props.exitState}
          terminalColumns={props.terminalColumns}
          compactLayout={props.compactLayout}
          tightLayout={props.tightLayout}
          containerPaddingY={props.containerPaddingY}
          containerGap={props.containerGap}
          selectedProvider={props.selectedProvider}
          apiKey={props.apiKey}
          cursorOffset={props.cursorOffset}
          handleApiKeyChange={props.handleApiKeyChange}
          handleApiKeySubmit={props.handleApiKeySubmit}
          handleCursorOffsetChange={props.handleCursorOffsetChange}
          isLoadingModels={props.isLoadingModels}
          modelLoadError={props.modelLoadError}
          getProviderLabel={props.getProviderLabel}
        />
      )
    }

    if (props.currentScreen === 'model') {
      return (
        <ModelSelectionScreen
          theme={props.theme}
          exitState={props.exitState}
          terminalRows={props.terminalRows}
          terminalColumns={props.terminalColumns}
          compactLayout={props.compactLayout}
          tightLayout={props.tightLayout}
          containerPaddingY={props.containerPaddingY}
          containerGap={props.containerGap}
          selectedProvider={props.selectedProvider}
          availableModels={props.availableModels}
          modelSearchQuery={props.modelSearchQuery}
          modelSearchCursorOffset={props.modelSearchCursorOffset}
          handleModelSearchChange={props.handleModelSearchChange}
          handleModelSearchCursorOffsetChange={
            props.handleModelSearchCursorOffsetChange
          }
          modelOptions={props.modelOptions}
          handleModelSelection={props.handleModelSelection}
          getProviderLabel={props.getProviderLabel}
        />
      )
    }

    if (props.currentScreen === 'modelParams') {
      const formFields = props.getFormFieldsForModelParams()
      return (
        <ModelParamsScreen
          theme={props.theme}
          exitState={props.exitState}
          terminalRows={props.terminalRows}
          compactLayout={props.compactLayout}
          tightLayout={props.tightLayout}
          containerPaddingY={props.containerPaddingY}
          containerGap={props.containerGap}
          selectedModel={props.selectedModel}
          formFields={formFields}
          activeFieldIndex={props.activeFieldIndex}
          setActiveFieldIndex={props.setActiveFieldIndex}
          maxTokens={props.maxTokens}
          setMaxTokens={props.setMaxTokens}
          setSelectedMaxTokensPreset={props.setSelectedMaxTokensPreset}
          setMaxTokensCursorOffset={props.setMaxTokensCursorOffset}
          reasoningEffortOptions={props.reasoningEffortOptions}
          reasoningEffort={props.reasoningEffort}
          setReasoningEffort={props.setReasoningEffort}
          requestStrategyOptions={props.requestStrategyOptions}
          requestStrategy={props.requestStrategy}
          setRequestStrategy={props.setRequestStrategy}
        />
      )
    }

    if (props.currentScreen === 'resourceName') {
      return (
        <ResourceNameScreen
          theme={props.theme}
          exitState={props.exitState}
          terminalColumns={props.terminalColumns}
          tightLayout={props.tightLayout}
          containerPaddingY={props.containerPaddingY}
          containerGap={props.containerGap}
          resourceName={props.resourceName}
          setResourceName={props.setResourceName}
          handleResourceNameSubmit={props.handleResourceNameSubmit}
          resourceNameCursorOffset={props.resourceNameCursorOffset}
          setResourceNameCursorOffset={props.setResourceNameCursorOffset}
        />
      )
    }

    if (props.currentScreen === 'baseUrl') {
      return (
        <BaseUrlScreen
          theme={props.theme}
          exitState={props.exitState}
          terminalColumns={props.terminalColumns}
          compactLayout={props.compactLayout}
          tightLayout={props.tightLayout}
          containerPaddingY={props.containerPaddingY}
          containerGap={props.containerGap}
          selectedProvider={props.selectedProvider}
          isLoadingModels={props.isLoadingModels}
          modelLoadError={props.modelLoadError}
          customBaseUrl={props.customBaseUrl}
          setCustomBaseUrl={props.setCustomBaseUrl}
          handleCustomBaseUrlSubmit={props.handleCustomBaseUrlSubmit}
          customBaseUrlCursorOffset={props.customBaseUrlCursorOffset}
          setCustomBaseUrlCursorOffset={props.setCustomBaseUrlCursorOffset}
          providerBaseUrl={props.providerBaseUrl}
          setProviderBaseUrl={props.setProviderBaseUrl}
          handleProviderBaseUrlSubmit={props.handleProviderBaseUrlSubmit}
          providerBaseUrlCursorOffset={props.providerBaseUrlCursorOffset}
          setProviderBaseUrlCursorOffset={props.setProviderBaseUrlCursorOffset}
        />
      )
    }

    if (props.currentScreen === 'modelInput') {
      return (
        <ModelInputScreen
          theme={props.theme}
          exitState={props.exitState}
          terminalColumns={props.terminalColumns}
          compactLayout={props.compactLayout}
          tightLayout={props.tightLayout}
          containerPaddingY={props.containerPaddingY}
          containerGap={props.containerGap}
          selectedProvider={props.selectedProvider}
          customModelName={props.customModelName}
          setCustomModelName={props.setCustomModelName}
          handleCustomModelSubmit={props.handleCustomModelSubmit}
          customModelNameCursorOffset={props.customModelNameCursorOffset}
          setCustomModelNameCursorOffset={props.setCustomModelNameCursorOffset}
        />
      )
    }

    if (props.currentScreen === 'contextLength') {
      return (
        <ContextLengthScreen
          theme={props.theme}
          exitState={props.exitState}
          compactLayout={props.compactLayout}
          tightLayout={props.tightLayout}
          containerPaddingY={props.containerPaddingY}
          containerGap={props.containerGap}
          contextLength={props.contextLength}
          contextLengthOptions={props.contextLengthOptions}
        />
      )
    }

    if (props.currentScreen === 'connectionTest') {
      return (
        <ConnectionTestScreen
          theme={props.theme}
          exitState={props.exitState}
          terminalColumns={props.terminalColumns}
          compactLayout={props.compactLayout}
          tightLayout={props.tightLayout}
          containerPaddingY={props.containerPaddingY}
          containerGap={props.containerGap}
          selectedProvider={props.selectedProvider}
          getProviderLabel={props.getProviderLabel}
          isTestingConnection={props.isTestingConnection}
          connectionTestResult={props.connectionTestResult}
        />
      )
    }

    if (props.currentScreen === 'confirmation') {
      return (
        <ConfirmationScreen
          theme={props.theme}
          exitState={props.exitState}
          compactLayout={props.compactLayout}
          tightLayout={props.tightLayout}
          containerPaddingY={props.containerPaddingY}
          containerGap={props.containerGap}
          selectedProvider={props.selectedProvider}
          selectedModel={props.selectedModel}
          resourceName={props.resourceName}
          ollamaBaseUrl={props.ollamaBaseUrl}
          customBaseUrl={props.customBaseUrl}
          apiKeyEnv={props.apiKeyEnv}
          hasStoredApiKey={props.hasStoredApiKey}
          validationError={props.validationError}
          activateAsMain={props.activateAsMain}
          getProviderLabel={props.getProviderLabel}
        />
      )
    }

    if (props.currentScreen === 'partnerProviders') {
      return (
        <PartnerProvidersScreen
          theme={props.theme}
          exitState={props.exitState}
          containerPaddingY={props.containerPaddingY}
          containerGap={props.containerGap}
          compactLayout={props.compactLayout}
          tightLayout={props.tightLayout}
          partnerProviderOptions={props.partnerProviderOptions}
          partnerProviderFocusIndex={props.partnerProviderFocusIndex}
          partnerReservedLines={props.partnerReservedLines}
          onPartnerProviderOptionPress={props.onPartnerProviderOptionPress}
          onPartnerProviderOptionWheel={props.onPartnerProviderOptionWheel}
          getWindowedOptionsLayout={getWindowedOptionsLayout}
          renderWindowedOptions={renderWindowedOptions}
        />
      )
    }

    if (props.currentScreen === 'partnerCodingPlans') {
      return (
        <PartnerCodingPlansScreen
          theme={props.theme}
          exitState={props.exitState}
          containerPaddingY={props.containerPaddingY}
          containerGap={props.containerGap}
          tightLayout={props.tightLayout}
          compactLayout={props.compactLayout}
          codingPlanOptions={props.codingPlanOptions}
          codingPlanFocusIndex={props.codingPlanFocusIndex}
          codingReservedLines={props.codingReservedLines}
          onCodingPlanOptionPress={props.onCodingPlanOptionPress}
          onCodingPlanOptionWheel={props.onCodingPlanOptionWheel}
          getWindowedOptionsLayout={getWindowedOptionsLayout}
          renderWindowedOptions={renderWindowedOptions}
        />
      )
    }

    return (
      <ProviderSelectionScreen
        theme={props.theme}
        exitState={props.exitState}
        containerPaddingY={props.containerPaddingY}
        containerGap={props.containerGap}
        compactLayout={props.compactLayout}
        tightLayout={props.tightLayout}
        mainMenuOptions={props.mainMenuOptions}
        providerFocusIndex={props.providerFocusIndex}
        providerReservedLines={props.providerReservedLines}
        onProviderOptionPress={props.onProviderOptionPress}
        onProviderOptionWheel={props.onProviderOptionWheel}
        getWindowedOptionsLayout={getWindowedOptionsLayout}
        renderWindowedOptions={renderWindowedOptions}
      />
    )
  })()

  return (
    <Box flexDirection="column" minHeight={minHeight}>
      {screen}
    </Box>
  )
}
