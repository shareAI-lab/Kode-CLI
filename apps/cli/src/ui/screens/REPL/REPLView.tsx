import { Box, Static, Text, type DOMElement, measureElement } from 'ink'
import * as React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import type { ToolUseConfirm } from '#ui-ink/components/permissions/PermissionRequest'
import { PermissionRequest } from '#ui-ink/components/permissions/PermissionRequest'
import PromptInput from '#ui-ink/components/PromptInput'
import { RequestStatusIndicator } from '#ui-ink/components/RequestStatusIndicator'
import {
  buildRunningTasksLayoutSignature,
  RunningTasksPanel,
} from '#ui-ink/components/RunningTasksPanel'
import { GoalStatusPanel } from '#ui-ink/components/GoalStatusPanel'
import { CostThresholdDialog } from '#ui-ink/components/CostThresholdDialog'
import { BinaryFeedback } from '#ui-ink/components/binary-feedback/BinaryFeedback'
import type { Goal } from '#core/goals'
import { MessageSelector } from '#ui-ink/components/MessageSelector'
import { PermissionProvider } from '#ui-ink/contexts/PermissionContext'
import { useTerminalSize } from '#ui-ink/hooks/useTerminalSize'
import { useBackgroundTaskSnapshots } from '#ui-ink/hooks/useBackgroundTaskSnapshots'
import { useFlickerDetector } from '#ui-ink/hooks/useFlickerDetector'
import {
  computeResponsiveRows,
  normalizeTerminalDimension,
} from '#ui-ink/primitives/layout/viewportRows'
import { countWrappedLines } from '#cli-utils/Cursor'
import type { NormalizedMessage } from '#core/utils/messages'
import type { Message as MessageType } from '#core/query'
import type { Tool } from '#core/tooling/Tool'
import { getTheme } from '#core/utils/theme'
import type { TranscriptItem } from './useTranscriptItems'
import type { BinaryFeedbackContext } from './types'
import { TransientViewportProvider } from '#ui-ink/contexts/TransientViewportContext'
import { AssistantStreamPreview } from './AssistantStreamPreview'
import type { AssistantStreamStore } from './assistantStreamStore'

const VIEWPORT_SAFE_MARGIN_ROWS = 1
const MEASURE_DEBOUNCE_MS = 150

export function getMessageSelectorLayoutSignature(
  isVisible: boolean,
  messageCount: number,
): number {
  return isVisible ? messageCount : 0
}

export function REPLView({
  conversationKey,
  safeMode,
  debug,
  staticOutputEpoch,
  staticItems,
  startupHeader,
  startupHeaderKey,
  showStartupHeader = false,
  transientItems,
  assistantStreamStore,
  activeGoal,
  toolJSX,
  toolUseConfirm,
  setToolUseConfirm,
  pendingToolUseConfirmCount,
  allowAllPendingToolUseConfirms,
  rejectAllPendingToolUseConfirms,
  toast,
  binaryFeedbackContext,
  setBinaryFeedbackContext,
  isLoading,
  verbose,
  normalizedMessages,
  tools,
  erroredToolUseIDs,
  inProgressToolUseIDs,
  unresolvedToolUseIDs,
  showingCostDialog,
  onCostDialogDone,
  shouldShowPromptInput,
  isMessageSelectorVisible,
  promptInputProps,
  messageSelectorMessages,
  onMessageSelectorSelect,
  onMessageSelectorEscape,
}: {
  conversationKey: string
  safeMode: boolean
  debug: boolean
  staticOutputEpoch: number
  staticItems: TranscriptItem[]
  startupHeader?: ReactNode
  startupHeaderKey?: string
  showStartupHeader?: boolean
  transientItems: TranscriptItem[]
  assistantStreamStore: AssistantStreamStore
  activeGoal: Goal | null
  toolJSX: {
    jsx: ReactNode | null
    shouldHidePromptInput: boolean
    displayMode?: 'inline' | 'fullscreen'
  } | null
  toolUseConfirm: ToolUseConfirm | null
  setToolUseConfirm: (confirm: ToolUseConfirm | null) => void
  pendingToolUseConfirmCount: number
  allowAllPendingToolUseConfirms: () => void
  rejectAllPendingToolUseConfirms: () => void
  toast: string | null
  binaryFeedbackContext: BinaryFeedbackContext | null
  setBinaryFeedbackContext: (ctx: BinaryFeedbackContext | null) => void
  isLoading: boolean
  verbose: boolean
  normalizedMessages: NormalizedMessage[]
  tools: Tool[]
  erroredToolUseIDs: Set<string>
  inProgressToolUseIDs: Set<string>
  unresolvedToolUseIDs: Set<string>
  showingCostDialog: boolean
  onCostDialogDone: () => void
  shouldShowPromptInput: boolean
  isMessageSelectorVisible: boolean
  promptInputProps: React.ComponentProps<typeof PromptInput>
  messageSelectorMessages: MessageType[]
  onMessageSelectorSelect: (message: MessageType) => void | Promise<void>
  onMessageSelectorEscape: () => void
}): React.ReactNode {
  const rootUiRef = useRef<DOMElement | null>(null)
  const mainControlsRef = useRef<DOMElement | null>(null)
  const messageSelectorRef = useRef<DOMElement | null>(null)
  const lastMeasureKeyRef = useRef('')
  const scheduledMeasureKeyRef = useRef('')
  const measureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { rows, columns } = useTerminalSize()
  const backgroundTasks = useBackgroundTaskSnapshots()
  const normalizedRows = normalizeTerminalDimension(rows, 0)
  const theme = getTheme()
  useFlickerDetector(
    rootUiRef,
    rows,
    debug || Boolean(process.env.KODE_DEBUG_FLICKER),
  )

  const isFullScreenToolView = toolJSX?.displayMode === 'fullscreen'
  const hasToolJSX = Boolean(toolJSX)
  const hasToolUseConfirm = Boolean(toolUseConfirm)
  const hasBinaryFeedback = Boolean(binaryFeedbackContext)
  const hasToast = Boolean(toast)
  const messageSelectorLayoutSignature = getMessageSelectorLayoutSignature(
    isMessageSelectorVisible,
    messageSelectorMessages.length,
  )
  const promptInputMeasureSignature = useMemo(() => {
    if (!shouldShowPromptInput) return ''

    const textInputColumns = Math.max(1, columns - 6)
    const textInputMaxHeight = computeResponsiveRows({
      rows,
      minRows: 1,
      maxRows: 8,
      ratio: 1 / 3,
    })
    const inputLineCount = countWrappedLines(
      promptInputProps.input,
      textInputColumns,
      textInputMaxHeight + 1,
    )
    const inputBoxHeight = Math.min(inputLineCount, textInputMaxHeight) + 2

    return [
      inputBoxHeight,
      promptInputProps.mode,
      promptInputProps.submitCount,
    ].join(':')
  }, [
    columns,
    promptInputProps.input,
    promptInputProps.mode,
    promptInputProps.submitCount,
    rows,
    shouldShowPromptInput,
  ])
  const runningTasksLayoutSignature = useMemo(
    () => buildRunningTasksLayoutSignature(backgroundTasks),
    [backgroundTasks],
  )
  const shouldRenderStartupHeader =
    Boolean(startupHeader) &&
    showStartupHeader &&
    normalizedRows > 4 &&
    !toolJSX &&
    !toolUseConfirm &&
    !isMessageSelectorVisible &&
    !binaryFeedbackContext &&
    !showingCostDialog
  // The startup header can grow after mount when asynchronous state (such as
  // the update check or MCP connection status) resolves. Keep that identity in
  // the control measurement key so the stream budget is recalculated.
  const startupHeaderMeasureSignature = shouldRenderStartupHeader
    ? (startupHeaderKey ?? 'visible')
    : ''
  const mountedStaticOutputEpochRef = useRef<number | null>(null)
  const staticOutputKey = `static-${staticOutputEpoch}`
  const shouldRenderStartupHeaderInControls = shouldRenderStartupHeader
  // Ink's Static owns an append cursor. Keep its item identity frozen while a
  // fullscreen/permission surface obscures the REPL so reopening the normal
  // layout appends only new output instead of replaying history from index 0.
  const staticItemsForRenderRef = useRef<{
    epoch: number
    items: TranscriptItem[]
  }>({ epoch: staticOutputEpoch, items: staticItems })

  const [mainControlsHeight, setMainControlsHeight] = useState(0)
  const [messageSelectorHeight, setMessageSelectorHeight] = useState(0)
  const [isLayoutMeasurementPending, setIsLayoutMeasurementPending] =
    useState(false)
  const stableControlsHeightRef = useRef(0)
  const layoutMeasureKey = useMemo(
    () =>
      [
        rows,
        columns,
        isMessageSelectorVisible ? 1 : 0,
        isFullScreenToolView ? 1 : 0,
        hasToolJSX ? 1 : 0,
        hasToolUseConfirm ? 1 : 0,
        hasBinaryFeedback ? 1 : 0,
        showingCostDialog ? 1 : 0,
        shouldShowPromptInput ? 1 : 0,
        hasToast ? 1 : 0,
        runningTasksLayoutSignature,
        startupHeaderMeasureSignature,
        isLoading ? 1 : 0,
        promptInputMeasureSignature,
        messageSelectorLayoutSignature,
      ].join(':'),
    [
      rows,
      columns,
      isMessageSelectorVisible,
      isFullScreenToolView,
      hasToolJSX,
      hasToolUseConfirm,
      hasBinaryFeedback,
      showingCostDialog,
      shouldShowPromptInput,
      hasToast,
      runningTasksLayoutSignature,
      startupHeaderMeasureSignature,
      isLoading,
      promptInputMeasureSignature,
      messageSelectorLayoutSignature,
    ],
  )
  const isLayoutMeasurementStale =
    lastMeasureKeyRef.current !== '' &&
    layoutMeasureKey !== lastMeasureKeyRef.current

  useEffect(() => {
    if (rows <= 0 || columns <= 0) {
      setIsLayoutMeasurementPending(prev => (prev ? false : prev))
      return undefined
    }

    if (
      layoutMeasureKey === lastMeasureKeyRef.current &&
      measureTimerRef.current === null
    ) {
      setIsLayoutMeasurementPending(prev => (prev ? false : prev))
      return undefined
    }

    if (measureTimerRef.current) {
      clearTimeout(measureTimerRef.current)
      measureTimerRef.current = null
    }

    scheduledMeasureKeyRef.current = layoutMeasureKey
    if (lastMeasureKeyRef.current !== '') {
      setIsLayoutMeasurementPending(prev => (prev ? prev : true))
    }
    measureTimerRef.current = setTimeout(() => {
      measureTimerRef.current = null
      if (scheduledMeasureKeyRef.current !== layoutMeasureKey) return
      lastMeasureKeyRef.current = layoutMeasureKey

      if (mainControlsRef.current) {
        const measured = measureElement(mainControlsRef.current).height
        setMainControlsHeight(prev => (prev === measured ? prev : measured))
      } else {
        setMainControlsHeight(prev => (prev === 0 ? prev : 0))
      }

      if (messageSelectorRef.current) {
        const measured = measureElement(messageSelectorRef.current).height
        setMessageSelectorHeight(prev => (prev === measured ? prev : measured))
      } else {
        setMessageSelectorHeight(prev => (prev === 0 ? prev : 0))
      }

      setIsLayoutMeasurementPending(prev => (prev ? false : prev))
    }, MEASURE_DEBOUNCE_MS)

    return () => {
      if (measureTimerRef.current) {
        clearTimeout(measureTimerRef.current)
        measureTimerRef.current = null
      }
    }
  }, [rows, columns, layoutMeasureKey])

  const isMinimizedViewport = normalizedRows <= 0
  const isMicroViewport = normalizedRows > 0 && normalizedRows <= 4
  const stableControlsHeight = useMemo(() => {
    const measuredHeight = mainControlsHeight
    if (stableControlsHeightRef.current === 0) {
      stableControlsHeightRef.current = measuredHeight
    } else {
      const diff = Math.abs(measuredHeight - stableControlsHeightRef.current)
      if (diff > 4) {
        stableControlsHeightRef.current = measuredHeight
      }
    }
    return stableControlsHeightRef.current
  }, [mainControlsHeight])
  const transientMaxHeight = Math.max(
    0,
    normalizedRows -
      stableControlsHeight -
      messageSelectorHeight -
      VIEWPORT_SAFE_MARGIN_ROWS,
  )
  const canShowTransientRegion =
    !isMicroViewport &&
    transientMaxHeight > 0 &&
    (isLoading || (!isLayoutMeasurementStale && !isLayoutMeasurementPending))
  const showRequestStatus =
    !isMicroViewport &&
    !toolJSX &&
    !toolUseConfirm &&
    !binaryFeedbackContext &&
    isLoading
  const transientViewportValue = useMemo(
    () => ({ maxHeight: transientMaxHeight }),
    [transientMaxHeight],
  )
  const shouldRenderMicroPrompt =
    !toolJSX &&
    !toolUseConfirm &&
    !isMessageSelectorVisible &&
    !binaryFeedbackContext &&
    !showingCostDialog &&
    shouldShowPromptInput
  const microStatus = toolUseConfirm
    ? 'Permission request - expand terminal'
    : toolJSX
      ? 'Tool view active - expand terminal'
      : isMessageSelectorVisible
        ? 'Message selector - expand terminal'
        : binaryFeedbackContext
          ? 'Feedback prompt - expand terminal'
          : showingCostDialog
            ? 'Cost notice - expand terminal'
            : isLoading
              ? 'Working… Esc to cancel'
              : null
  const hasStaticOutput = staticItems.length > 0
  const isStaticOutputObscured = isFullScreenToolView || hasToolUseConfirm
  if (staticItemsForRenderRef.current.epoch !== staticOutputEpoch) {
    staticItemsForRenderRef.current = {
      epoch: staticOutputEpoch,
      items: isStaticOutputObscured ? [] : staticItems,
    }
  } else if (!isStaticOutputObscured) {
    staticItemsForRenderRef.current = {
      epoch: staticOutputEpoch,
      items: staticItems,
    }
  }
  const staticItemsForRender = staticItemsForRenderRef.current.items
  const shouldMountStaticOutputNormally =
    !isMinimizedViewport &&
    !isMicroViewport &&
    !isStaticOutputObscured &&
    hasStaticOutput
  if (shouldMountStaticOutputNormally) {
    mountedStaticOutputEpochRef.current = staticOutputEpoch
  }
  const shouldPreserveStaticOutputInConstrainedViewport =
    (isMinimizedViewport || isMicroViewport || isStaticOutputObscured) &&
    hasStaticOutput &&
    mountedStaticOutputEpochRef.current === staticOutputEpoch
  const shouldRenderStaticOutput =
    shouldMountStaticOutputNormally ||
    shouldPreserveStaticOutputInConstrainedViewport

  if (isMinimizedViewport) {
    return (
      <TransientViewportProvider value={transientViewportValue}>
        <PermissionProvider
          conversationKey={conversationKey}
          isBypassPermissionsModeAvailable={!safeMode}
        >
          <Box ref={rootUiRef} flexDirection="column" width="100%">
            {shouldRenderStaticOutput && (
              <Static key={staticOutputKey} items={staticItemsForRender}>
                {(item: TranscriptItem) => item.jsx}
              </Static>
            )}
          </Box>
        </PermissionProvider>
      </TransientViewportProvider>
    )
  }

  if (isMicroViewport) {
    return (
      <TransientViewportProvider value={transientViewportValue}>
        <PermissionProvider
          conversationKey={conversationKey}
          isBypassPermissionsModeAvailable={!safeMode}
        >
          <Box
            ref={rootUiRef}
            flexDirection="column"
            height={normalizedRows}
            overflow="hidden"
            width="100%"
          >
            {shouldRenderStaticOutput && (
              <Static key={staticOutputKey} items={staticItemsForRender}>
                {(item: TranscriptItem) => item.jsx}
              </Static>
            )}
            {microStatus && (
              <Text dimColor wrap="truncate-end">
                {microStatus}
              </Text>
            )}
            {shouldRenderMicroPrompt && (
              <PromptInput
                key={`prompt-${conversationKey}`}
                {...promptInputProps}
                suppressStatusLine
              />
            )}
          </Box>
        </PermissionProvider>
      </TransientViewportProvider>
    )
  }

  return (
    <TransientViewportProvider value={transientViewportValue}>
      <PermissionProvider
        conversationKey={conversationKey}
        isBypassPermissionsModeAvailable={!safeMode}
      >
        {isFullScreenToolView && toolJSX ? (
          <Box ref={rootUiRef} flexDirection="column" width="100%">
            {shouldRenderStaticOutput && (
              <Static key={staticOutputKey} items={staticItemsForRender}>
                {(item: TranscriptItem) => item.jsx}
              </Static>
            )}
            {toolJSX.jsx}
          </Box>
        ) : toolUseConfirm ? (
          <Box ref={rootUiRef} flexDirection="column" width="100%">
            {shouldRenderStaticOutput && (
              <Static key={staticOutputKey} items={staticItemsForRender}>
                {(item: TranscriptItem) => item.jsx}
              </Static>
            )}
            <PermissionRequest
              toolUseConfirm={toolUseConfirm}
              onDone={() => setToolUseConfirm(null)}
              verbose={verbose}
              pendingCount={pendingToolUseConfirmCount}
              onAllowAllPending={allowAllPendingToolUseConfirms}
              onRejectAllPending={rejectAllPendingToolUseConfirms}
            />
          </Box>
        ) : (
          <Box ref={rootUiRef} flexDirection="column" width="100%">
            {shouldRenderStaticOutput && (
              <Static key={staticOutputKey} items={staticItemsForRender}>
                {(item: TranscriptItem) => item.jsx}
              </Static>
            )}

            <AssistantStreamPreview
              store={assistantStreamStore}
              transientItems={transientItems}
              maxHeight={transientMaxHeight}
              isVisible={canShowTransientRegion}
              isActive={isLoading}
              debug={debug}
            />

            <Box
              ref={mainControlsRef}
              borderColor={theme.error}
              borderStyle={debug ? 'single' : undefined}
              flexDirection="column"
              width="100%"
            >
              {shouldRenderStartupHeaderInControls && (
                <Box flexDirection="column" width="100%">
                  {startupHeader}
                </Box>
              )}

              {showRequestStatus && (
                <Box paddingX={1}>
                  <RequestStatusIndicator marginTop={0} />
                </Box>
              )}

              {!toolUseConfirm &&
                !toolJSX &&
                !binaryFeedbackContext &&
                !isMessageSelectorVisible &&
                !showingCostDialog && (
                  <RunningTasksPanel
                    maxWidth={columns}
                    tasks={backgroundTasks}
                  />
                )}

              {!toolUseConfirm &&
                !toolJSX &&
                !binaryFeedbackContext &&
                !isMessageSelectorVisible &&
                !showingCostDialog && (
                  <GoalStatusPanel maxWidth={columns} goal={activeGoal} />
                )}

              {toast &&
                !toolUseConfirm &&
                !toolJSX &&
                !binaryFeedbackContext && (
                  <Box paddingX={1} marginTop={1}>
                    <Text color={theme.warning} wrap="truncate-end">
                      {toast}
                    </Text>
                  </Box>
                )}

              {toolJSX ? toolJSX.jsx : null}

              {!toolJSX &&
                binaryFeedbackContext &&
                !isMessageSelectorVisible && (
                  <BinaryFeedback
                    m1={binaryFeedbackContext.m1}
                    m2={binaryFeedbackContext.m2}
                    resolve={result => {
                      binaryFeedbackContext.resolve(result)
                      setTimeout(() => setBinaryFeedbackContext(null), 0)
                    }}
                    verbose={verbose}
                    normalizedMessages={normalizedMessages}
                    tools={tools}
                    debug={debug}
                    erroredToolUseIDs={erroredToolUseIDs}
                    inProgressToolUseIDs={inProgressToolUseIDs}
                    unresolvedToolUseIDs={unresolvedToolUseIDs}
                  />
                )}

              {!toolJSX &&
                !toolUseConfirm &&
                !isMessageSelectorVisible &&
                !binaryFeedbackContext &&
                showingCostDialog && (
                  <CostThresholdDialog onDone={onCostDialogDone} />
                )}

              {!toolUseConfirm &&
                !toolJSX?.shouldHidePromptInput &&
                shouldShowPromptInput &&
                !isMessageSelectorVisible &&
                !binaryFeedbackContext &&
                !showingCostDialog && (
                  // Keep the prompt's height stable while the transient region
                  // waits for measurement; hiding its chrome causes a visible
                  // collapse-and-expand flash at the bottom of the terminal.
                  <PromptInput
                    key={`prompt-${conversationKey}`}
                    {...promptInputProps}
                  />
                )}
            </Box>

            {isMessageSelectorVisible && (
              <Box ref={messageSelectorRef} flexDirection="column" width="100%">
                <MessageSelector
                  erroredToolUseIDs={erroredToolUseIDs}
                  unresolvedToolUseIDs={unresolvedToolUseIDs}
                  messages={messageSelectorMessages}
                  onSelect={onMessageSelectorSelect}
                  onEscape={onMessageSelectorEscape}
                  tools={tools}
                />
              </Box>
            )}
          </Box>
        )}
      </PermissionProvider>
    </TransientViewportProvider>
  )
}
