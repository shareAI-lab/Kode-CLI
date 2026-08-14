import { Box, Text } from 'ink'
import {
  isCompactViewportHeight,
  normalizeTerminalDimension,
} from '#ui-ink/primitives/layout/viewportRows'
import * as React from 'react'
import { SentryErrorBoundary } from '#ui-ink/components/SentryErrorBoundary'
import TextInput from '#ui-ink/components/TextInput'
import { TokenWarning } from '#ui-ink/components/TokenWarning'
import { getCachedStringWidth } from '#cli-utils/textWidth'
import type { Key } from '#ui-ink/hooks/useKeypress'
import {
  formatContextLimit,
  formatTokenCount,
} from '#ui-ink/utils/tokenDisplay'
import type { Theme } from '#core/utils/theme'
import type { ClipboardImage } from '#core/utils/image/media'
import type { PromptMode } from './types'
import { PromptInputCompletionPanel } from './PromptInputCompletionPanel'
import { PendingPrompts } from './PendingPrompts'
import { QueuedPrompts } from './QueuedPrompts'
import {
  getPromptModeBorderColor,
  getPromptModePrefix,
} from './promptModeSpecs'

type ModelInfo = {
  name: string
  provider: string
  contextLength: number
  currentTokens: number
  reasoningEffort?: string
} | null

export { formatTokenCount as formatPromptTokenCount }

type ExitMessageState = { show: boolean; key?: string }
type InlineMessageState = { show: boolean; text?: string }
type ToastMessageState = {
  show: boolean
  text?: string
  kind?: 'info' | 'success' | 'warning' | 'error'
}

type Suggestion = {
  type: string
  value: string
  displayValue: string
  metadata?: { color?: string }
}

export function PromptInputView({
  mode,
  theme,
  currentPwd,
  modelInfo,
  input,
  cursorOffset,
  setCursorOffset,
  onSubmit,
  onChange,
  isEditingExternally,
  isDisabled,
  isLoading,
  pendingPrompts,
  queuedPrompts,
  completionActive,
  historyIndex,
  suggestions,
  selectedIndex,
  emptyDirMessage,
  handleHistoryUp,
  handleHistoryDown,
  resetHistory,
  placeholder,
  submitCount,
  onExit,
  onExitMessage,
  onMessage,
  onImagePaste,
  onTextPaste,
  onSpecialKey,
  exitMessage,
  message,
  clearInputPending,
  rewindPending,
  modelSwitchMessage,
  toastMessage,
  statusLine,
  customStatusLineActive,
  statusLinePadding,
  suppressStatusLine = false,
  tokenUsage,
  textInputColumns,
  textInputMaxHeight,
  completionReservedRows,
  terminalRows,
  terminalColumns,
}: {
  mode: PromptMode
  theme: Theme
  currentPwd: string
  modelInfo: ModelInfo
  input: string
  cursorOffset: number
  setCursorOffset: (offset: number) => void
  onSubmit: (value: string) => void
  onChange: (value: string) => void
  isEditingExternally: boolean
  isDisabled: boolean
  isLoading: boolean
  pendingPrompts: string[]
  queuedPrompts: string[]
  completionActive: boolean
  historyIndex: number
  suggestions: Suggestion[]
  selectedIndex: number
  emptyDirMessage: string
  handleHistoryUp: () => void
  handleHistoryDown: () => void
  resetHistory: () => void
  placeholder: string
  submitCount: number
  onExit: () => void
  onExitMessage: (show: boolean, key?: string) => void
  onMessage: (show: boolean, text?: string) => void
  onImagePaste: (image: ClipboardImage) => string | void
  onTextPaste: (text: string) => void
  onSpecialKey: (input: string, key: Key) => boolean
  exitMessage: ExitMessageState
  message: InlineMessageState
  clearInputPending: boolean
  rewindPending: boolean
  modelSwitchMessage: InlineMessageState
  toastMessage: ToastMessageState
  statusLine: string | null
  customStatusLineActive: boolean
  statusLinePadding: number
  suppressStatusLine?: boolean
  tokenUsage: number
  textInputColumns: number
  textInputMaxHeight: number
  completionReservedRows: number
  terminalRows: number
  terminalColumns: number
}): React.ReactNode {
  const rows = terminalRows
  const columns = terminalColumns
  const normalizedRows = normalizeTerminalDimension(rows, 0)
  const isMicroViewport = normalizedRows > 0 && normalizedRows <= 4
  const compact = isCompactViewportHeight(rows, {
    microRows: 12,
    tightRows: 15,
    compactRows: 15,
  })
  const showAuxiliaryRows = !isMicroViewport
  const modePrefix = getPromptModePrefix({ mode, theme, isLoading })
  const contextLimitLabel = formatContextLimit(modelInfo?.contextLength)
  const hasPriorityStatusMessage =
    exitMessage.show ||
    message.show ||
    rewindPending ||
    clearInputPending ||
    modelSwitchMessage.show ||
    toastMessage.show
  const suppressNonessentialChrome =
    suppressStatusLine && !hasPriorityStatusMessage
  const showStatusLine =
    normalizedRows > 8 && (!suppressStatusLine || hasPriorityStatusMessage)
  const showModelInfo =
    Boolean(modelInfo) &&
    !compact &&
    !customStatusLineActive &&
    !hasPriorityStatusMessage &&
    columns >= 80
  const modelStatusText =
    showModelInfo && modelInfo
      ? `${modelInfo.name}${
          modelInfo.reasoningEffort ? ` (${modelInfo.reasoningEffort})` : ''
        }${
          contextLimitLabel
            ? ` \u00b7 ${formatTokenCount(modelInfo.currentTokens)}/${contextLimitLabel}`
            : ''
        }`
      : null
  const horizontalStatusPadding = 1 + Math.max(0, statusLinePadding)
  const statusContentColumns = Math.max(
    1,
    columns - horizontalStatusPadding * 2,
  )
  const modelStatusWidth = modelStatusText
    ? Math.min(
        40,
        Math.max(
          20,
          Math.min(
            getCachedStringWidth(modelStatusText) + 2,
            Math.floor(statusContentColumns * 0.32),
          ),
        ),
      )
    : 0
  const showInlineModelStatus =
    Boolean(modelStatusText) && statusContentColumns - modelStatusWidth > 24
  const statusTextWidth = showInlineModelStatus
    ? Math.max(1, statusContentColumns - modelStatusWidth - 1)
    : statusContentColumns
  const statusRowWidth = Math.max(1, columns)

  if (normalizedRows <= 0) return null

  return (
    <Box
      flexDirection="column"
      height={isMicroViewport ? normalizedRows : undefined}
      overflow={isMicroViewport ? 'hidden' : undefined}
    >
      {showAuxiliaryRows && pendingPrompts.length > 0 && (
        <PendingPrompts pendingPrompts={pendingPrompts} width={columns} />
      )}

      {showAuxiliaryRows && queuedPrompts.length > 0 && (
        <QueuedPrompts queuedPrompts={queuedPrompts} width={columns} />
      )}

      {/* Input box */}
      <Box
        alignItems="flex-start"
        justifyContent="flex-start"
        borderTop={showAuxiliaryRows && !suppressNonessentialChrome}
        borderBottom={showAuxiliaryRows && !suppressNonessentialChrome}
        borderLeft={false}
        borderRight={false}
        borderColor={getPromptModeBorderColor(mode, theme)}
        borderDimColor={false}
        borderStyle="single"
        width="100%"
      >
        <Box
          alignItems="flex-start"
          alignSelf="flex-start"
          flexWrap="nowrap"
          justifyContent="flex-start"
          width={2}
        >
          <Text color={modePrefix.color}>{modePrefix.text}</Text>
        </Box>
        <Box paddingRight={1}>
          <TextInput
            multiline
            focus={!isEditingExternally}
            onSubmit={onSubmit}
            onChange={onChange}
            value={input}
            onHistoryUp={handleHistoryUp}
            onHistoryDown={handleHistoryDown}
            onHistoryReset={resetHistory}
            placeholder={submitCount > 0 ? undefined : placeholder}
            onExit={onExit}
            onExitMessage={onExitMessage}
            onMessage={onMessage}
            onImagePaste={onImagePaste}
            columns={textInputColumns}
            maxHeight={textInputMaxHeight}
            isDimmed={isDisabled || isLoading || isEditingExternally}
            disableCursorMovementForUpDownKeys={() =>
              completionActive || historyIndex > 0 || !input.includes('\n')
            }
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            onPaste={onTextPaste}
            onSpecialKey={onSpecialKey}
          />
        </Box>
      </Box>

      {/* PWD line - first line below input */}
      {showAuxiliaryRows && !compact && !suppressNonessentialChrome && (
        <Box flexDirection="row" paddingX={1}>
          <Text color={theme.text} wrap="truncate-end">
            {currentPwd}
          </Text>
        </Box>
      )}

      {/* Status line - below PWD */}
      {showAuxiliaryRows &&
        !completionActive &&
        suggestions.length === 0 &&
        showStatusLine && (
          <Box flexDirection="column">
            <Box
              flexDirection="row"
              overflow="hidden"
              paddingX={horizontalStatusPadding}
              width={statusRowWidth}
            >
              <Box
                justifyContent="flex-start"
                flexShrink={1}
                width={statusTextWidth}
              >
                {exitMessage.show ? (
                  <Text color={theme.text} wrap="truncate-end">
                    Press {exitMessage.key} again to exit
                  </Text>
                ) : message.show ? (
                  <Text color={theme.text} wrap="truncate-end">
                    {message.text}
                  </Text>
                ) : rewindPending ? (
                  <Text color={theme.text} wrap="truncate-end">
                    Press Escape again to rewind
                  </Text>
                ) : clearInputPending ? (
                  <Text color={theme.text} wrap="truncate-end">
                    Press Escape again to clear input
                  </Text>
                ) : modelSwitchMessage.show ? (
                  <Text color={theme.success} wrap="truncate-end">
                    {modelSwitchMessage.text}
                  </Text>
                ) : toastMessage.show ? (
                  <Text
                    color={
                      toastMessage.kind === 'error'
                        ? theme.error
                        : toastMessage.kind === 'warning'
                          ? theme.warning
                          : toastMessage.kind === 'success'
                            ? theme.success
                            : theme.text
                    }
                    wrap="truncate-end"
                  >
                    {toastMessage.text}
                  </Text>
                ) : statusLine ? (
                  <Text color={theme.text} wrap="truncate-end">
                    {statusLine}
                  </Text>
                ) : null}
              </Box>
              {!compact &&
                !hasPriorityStatusMessage &&
                showInlineModelStatus && (
                  <SentryErrorBoundary
                    children={
                      <Box
                        flexDirection="column"
                        flexShrink={0}
                        marginLeft={1}
                        overflow="hidden"
                        width={modelStatusWidth}
                      >
                        <Text color={theme.text} wrap="truncate-middle">
                          {modelStatusText}
                        </Text>
                        <TokenWarning
                          tokenUsage={tokenUsage}
                          contextLimit={modelInfo?.contextLength}
                        />
                      </Box>
                    }
                  />
                )}
            </Box>
          </Box>
        )}

      {showAuxiliaryRows && completionActive && suggestions.length > 0 && (
        <PromptInputCompletionPanel
          theme={theme}
          suggestions={suggestions}
          selectedIndex={selectedIndex}
          emptyDirMessage={emptyDirMessage}
          tokenUsage={tokenUsage}
          contextLimit={modelInfo?.contextLength}
          reservedRows={completionReservedRows}
          rows={rows}
          columns={columns}
        />
      )}
    </Box>
  )
}
