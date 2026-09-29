import { Box, Static, Text, type DOMElement, measureElement } from 'ink'
import * as React from 'react'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import type { ToolUseConfirm } from '#ui-ink/components/permissions/PermissionRequest'
import { PermissionRequest } from '#ui-ink/components/permissions/PermissionRequest'
import { ElicitationRequest } from '#ui-ink/components/mcp/ElicitationRequest'
import type { McpElicitationPrompt } from '#cli-services/mcpCapabilities'
import PromptInput from '#ui-ink/components/PromptInput'
import { RequestStatusIndicator } from '#ui-ink/components/RequestStatusIndicator'
import { CostThresholdDialog } from '#ui-ink/components/CostThresholdDialog'
import { BinaryFeedback } from '#ui-ink/components/binary-feedback/BinaryFeedback'
import { MessageSelector } from '#ui-ink/components/MessageSelector'
import { PermissionProvider } from '#ui-ink/contexts/PermissionContext'
import { useTerminalSize } from '#ui-ink/hooks/useTerminalSize'
import { useFlickerDetector } from '#ui-ink/hooks/useFlickerDetector'
import type { NormalizedMessage } from '#core/utils/messages'
import type { Message as MessageType } from '#core/query'
import type { Tool } from '#core/tooling/Tool'
import type { TranscriptItem } from './useTranscriptItems'
import type { BinaryFeedbackContext } from './types'
import { TransientViewportProvider } from '#ui-ink/contexts/TransientViewportContext'

const VIEWPORT_SAFE_MARGIN_ROWS = 1
const MEASURE_DEBOUNCE_MS = 400

export function REPLView({
  conversationKey,
  safeMode,
  debug,
  forkNumber,
  staticItems,
  transientItems,
  toolJSX,
  toolUseConfirm,
  setToolUseConfirm,
  mcpElicitation,
  setMcpElicitation,
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
  forkNumber: number
  staticItems: TranscriptItem[]
  transientItems: TranscriptItem[]
  toolJSX: {
    jsx: ReactNode | null
    shouldHidePromptInput: boolean
    displayMode?: 'inline' | 'fullscreen'
  } | null
  toolUseConfirm: ToolUseConfirm | null
  setToolUseConfirm: (confirm: ToolUseConfirm | null) => void
  mcpElicitation: McpElicitationPrompt | null
  setMcpElicitation: (prompt: McpElicitationPrompt | null) => void
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
  const lastMeasureAtRef = useRef(0)
  const { rows, columns } = useTerminalSize()
  useFlickerDetector(
    rootUiRef,
    rows,
    debug || Boolean(process.env.KODE_DEBUG_FLICKER),
  )

  const isFullScreenToolView = toolJSX?.displayMode === 'fullscreen'
  const hasToolJSX = Boolean(toolJSX)
  const hasToolUseConfirm = Boolean(toolUseConfirm)
  const hasMcpElicitation = Boolean(mcpElicitation)
  const hasBinaryFeedback = Boolean(binaryFeedbackContext)
  const hasToast = Boolean(toast)

  const [mainControlsHeight, setMainControlsHeight] = useState(0)
  const [messageSelectorHeight, setMessageSelectorHeight] = useState(0)

  useLayoutEffect(() => {
    if (rows <= 0 || columns <= 0) return
    const measureKey = [
      rows,
      columns,
      isMessageSelectorVisible ? 1 : 0,
      isFullScreenToolView ? 1 : 0,
      hasToolJSX ? 1 : 0,
      hasToolUseConfirm ? 1 : 0,
      hasMcpElicitation ? 1 : 0,
      hasBinaryFeedback ? 1 : 0,
      showingCostDialog ? 1 : 0,
      shouldShowPromptInput ? 1 : 0,
      hasToast ? 1 : 0,
      isLoading ? 1 : 0,
      messageSelectorMessages.length,
    ].join(':')

    const now = Date.now()
    if (
      measureKey === lastMeasureKeyRef.current &&
      now - lastMeasureAtRef.current < 200
    ) {
      return
    }

    lastMeasureKeyRef.current = measureKey
    lastMeasureAtRef.current = now

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
  }, [
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
    isLoading,
    messageSelectorMessages.length,
  ])

  const transientMaxHeight = Math.max(
    1,
    rows -
      mainControlsHeight -
      messageSelectorHeight -
      VIEWPORT_SAFE_MARGIN_ROWS,
  )
  const transientViewportValue = useMemo(
    () => ({ maxHeight: transientMaxHeight }),
    [transientMaxHeight],
  )

  return (
    <TransientViewportProvider value={transientViewportValue}>
      <PermissionProvider
        conversationKey={conversationKey}
        isBypassPermissionsModeAvailable={!safeMode}
      >
        {isFullScreenToolView && toolJSX ? (
          <Box ref={rootUiRef} flexDirection="column" width="100%">
            {toolJSX.jsx}
          </Box>
        ) : (
          <Box ref={rootUiRef} flexDirection="column" width="100%">
            <Static key={`static-${forkNumber}`} items={staticItems}>
              {(item: TranscriptItem) => item.jsx}
            </Static>

            <Box flexDirection="column" width="100%">
              {transientItems.map(item => item.jsx)}
              {/* Status indicator at bottom of messages, above controls */}
              {!toolJSX &&
                !toolUseConfirm &&
                !binaryFeedbackContext &&
                isLoading && <RequestStatusIndicator />}
            </Box>

            <Box
              ref={mainControlsRef}
              borderColor="red"
              borderStyle={debug ? 'single' : undefined}
              flexDirection="column"
              width="100%"
            >
              {toast &&
                !toolUseConfirm &&
                !toolJSX &&
                !binaryFeedbackContext && (
                  <Box paddingX={1} marginTop={1}>
                    <Text color="yellow" dimColor wrap="truncate-end">
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
                toolUseConfirm &&
                !isMessageSelectorVisible &&
                !binaryFeedbackContext && (
                  <PermissionRequest
                    toolUseConfirm={toolUseConfirm}
                    onDone={() => setToolUseConfirm(null)}
                    verbose={verbose}
                  />
                )}

              {!toolJSX &&
                !toolUseConfirm &&
                mcpElicitation &&
                !isMessageSelectorVisible &&
                !binaryFeedbackContext && (
                  <ElicitationRequest
                    prompt={mcpElicitation}
                    onDone={() => setMcpElicitation(null)}
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
                !mcpElicitation &&
                !toolJSX?.shouldHidePromptInput &&
                shouldShowPromptInput &&
                !isMessageSelectorVisible &&
                !binaryFeedbackContext &&
                !showingCostDialog && (
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
