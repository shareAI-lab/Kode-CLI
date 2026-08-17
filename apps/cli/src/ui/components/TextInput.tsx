import React from 'react'
import { Text } from 'ink'
import chalk from 'chalk'
import { useTextInput } from '#ui-ink/hooks/useTextInput'
import { getTheme } from '#core/utils/theme'
import { type Key, useKeypress } from '#ui-ink/hooks/useKeypress'
import { PASTE_PROTECTION_RETURN_KEY_NAME } from '#ui-ink/contexts/KeypressContext'
import {
  normalizeLineEndings,
  shouldAggregatePasteChunk,
  shouldTreatAsSpecialPaste,
} from '#core/utils/paste'
import { terminalCapabilityManager } from '#ui-ink/utils/terminalCapabilityManager'
import { useBracketedPasteSequences } from './TextInputBracketedPaste'
import type { Props } from './TextInput.types'
export type { Props } from './TextInput.types'

// Character codes - use numeric comparison to survive minification
const BACKSPACE_CODE = 8 // \x08
const DEL_CODE = 127 // \x7f
const PASTE_GUARD_MESSAGE = 'Paste detected. Press Enter again to send.'
const LEGACY_PASTE_AGGREGATION_DELAY_MS = 75
const SPECIAL_PASTE_AGGREGATION_DELAY_MS = 32

// Helper to check if input is a backspace character
function isBackspaceChar(input: string): boolean {
  if (input.length !== 1) return false
  const code = input.charCodeAt(0)
  return code === BACKSPACE_CODE || code === DEL_CODE
}

function isOptionKeyPressed(key: Key): boolean {
  const optionValue = (key as unknown as Record<string, unknown>).option
  return optionValue === true
}

export function __getLineFeedInputActionForTests(args: {
  multiline: boolean
  key: Key
}): 'newline' | 'submit' {
  if (!args.multiline) return 'submit'
  if (
    args.key.shift ||
    args.key.meta ||
    args.key.ctrl ||
    isOptionKeyPressed(args.key)
  ) {
    return 'newline'
  }
  return 'submit'
}

export function __getPasteAggregationDelayForTests(args: {
  input: string
  hasPendingPaste: boolean
  terminalColumns?: number
}): number | null {
  const options = { terminalColumns: args.terminalColumns }
  if (!shouldAggregatePasteChunk(args.input, args.hasPendingPaste, options)) {
    return null
  }
  return shouldTreatAsSpecialPaste(args.input, options)
    ? SPECIAL_PASTE_AGGREGATION_DELAY_MS
    : LEGACY_PASTE_AGGREGATION_DELAY_MS
}

export default function TextInput({
  value: originalValue,
  placeholder = '',
  focus = true,
  mask,
  displayValue,
  multiline = false,
  highlightPastedText = false,
  showCursor = true,
  onChange,
  onSubmit,
  onExit,
  onHistoryUp,
  onHistoryDown,
  onExitMessage,
  onMessage,
  onHistoryReset,
  columns,
  maxHeight,
  onImagePaste,
  onPaste,
  isDimmed = false,
  disableCursorMovementForUpDownKeys = false,
  onSpecialKey,
  cursorOffset,
  onChangeCursorOffset,
}: Props) {
  const { onInput, renderedValue, getCurrentInputState } = useTextInput({
    value: originalValue,
    onChange,
    onSubmit,
    onExit,
    onExitMessage,
    onMessage,
    onHistoryReset,
    onHistoryUp,
    onHistoryDown,
    focus,
    mask,
    multiline,
    cursorChar: showCursor ? ' ' : '',
    highlightPastedText,
    invert: chalk.inverse,
    themeText: (text: string) => chalk.hex(getTheme().text)(text),
    columns,
    maxHeight,
    onImagePaste,
    disableCursorMovementForUpDownKeys,
    externalOffset: cursorOffset,
    onOffsetChange: onChangeCursorOffset,
  })

  // Paste aggregation stays out of React state so large paste bursts don't
  // trigger a render per chunk.
  const pasteChunksRef = React.useRef<string[]>([])
  const pasteTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  const pasteGuardUntilRef = React.useRef<number>(0)
  const pasteWarningTimeoutRef = React.useRef<ReturnType<
    typeof setTimeout
  > | null>(null)
  const deferredPasteTimersRef = React.useRef(
    new Set<ReturnType<typeof setTimeout>>(),
  )
  const mountedRef = React.useRef(true)
  const onMessageRef = React.useRef<Props['onMessage']>(onMessage)
  const onPasteRef = React.useRef<Props['onPaste']>(onPaste)

  React.useEffect(() => {
    onMessageRef.current = onMessage
  }, [onMessage])

  React.useEffect(() => {
    onPasteRef.current = onPaste
  }, [onPaste])

  const deliverPaste = React.useCallback(
    (text: string) => {
      onPasteRef.current?.(text, getCurrentInputState())
    },
    [getCurrentInputState],
  )

  const schedulePasteDelivery = React.useCallback(
    (text: string) => {
      const timer = setTimeout(() => {
        deferredPasteTimersRef.current.delete(timer)
        if (mountedRef.current) deliverPaste(text)
      }, 0)
      deferredPasteTimersRef.current.add(timer)
    },
    [deliverPaste],
  )

  const isPasteTrusted = React.useCallback(() => {
    return (
      terminalCapabilityManager.isBracketedPasteEnabled() ||
      terminalCapabilityManager.isKittyProtocolEnabled()
    )
  }, [])

  const clearPasteWarning = React.useCallback(() => {
    if (pasteWarningTimeoutRef.current) {
      clearTimeout(pasteWarningTimeoutRef.current)
      pasteWarningTimeoutRef.current = null
    }
    onMessageRef.current?.(false)
  }, [])

  const showPasteWarning = React.useCallback(() => {
    const onMessage = onMessageRef.current
    if (!onMessage) return
    onMessage(true, PASTE_GUARD_MESSAGE)
    if (pasteWarningTimeoutRef.current) {
      clearTimeout(pasteWarningTimeoutRef.current)
    }
    pasteWarningTimeoutRef.current = setTimeout(() => {
      onMessageRef.current?.(false)
      pasteWarningTimeoutRef.current = null
    }, 1000)
  }, [])

  const armPasteGuard = React.useCallback(() => {
    if (isPasteTrusted()) return
    pasteGuardUntilRef.current = Date.now() + 20
  }, [isPasteTrusted])

  React.useEffect(
    () => () => {
      mountedRef.current = false
      clearPasteWarning()
      if (pasteTimeoutRef.current) {
        clearTimeout(pasteTimeoutRef.current)
        pasteTimeoutRef.current = null
      }
      for (const timer of deferredPasteTimersRef.current) {
        clearTimeout(timer)
      }
      deferredPasteTimersRef.current.clear()
      pasteChunksRef.current = []
    },
    [clearPasteWarning],
  )

  const flushAggregatedPaste = React.useCallback(() => {
    if (pasteTimeoutRef.current) {
      clearTimeout(pasteTimeoutRef.current)
      pasteTimeoutRef.current = null
    }
    pasteGuardUntilRef.current = 0
    const pastedText = pasteChunksRef.current.join('')
    pasteChunksRef.current = []
    if (!pastedText) return

    schedulePasteDelivery(pastedText)
  }, [schedulePasteDelivery])

  const shouldBlockEnter = React.useCallback(
    (key: Key): boolean => {
      if (!key.return || key.shift || key.meta) return false
      if (isPasteTrusted()) return false
      if (pasteTimeoutRef.current !== null) {
        flushAggregatedPaste()
        showPasteWarning()
        return true
      }
      if (!pasteGuardUntilRef.current) return false
      if (Date.now() >= pasteGuardUntilRef.current) return false
      pasteGuardUntilRef.current = 0
      showPasteWarning()
      return true
    },
    [flushAggregatedPaste, isPasteTrusted, showPasteWarning],
  )

  const handleBracketedPasteSequences = useBracketedPasteSequences({
    insertText: (text: string) => onInput(text, {} as Key),
    onPaste,
    terminalColumns: columns,
  })

  const resetPasteTimeout = React.useCallback(
    (delayMs: number) => {
      if (pasteTimeoutRef.current) {
        clearTimeout(pasteTimeoutRef.current)
      }
      pasteTimeoutRef.current = setTimeout(flushAggregatedPaste, delayMs)
    },
    [flushAggregatedPaste],
  )

  const wrappedOnInput = (input: string, key: Key): void => {
    if (key.name === PASTE_PROTECTION_RETURN_KEY_NAME) {
      if (pasteTimeoutRef.current !== null) {
        flushAggregatedPaste()
      }
      showPasteWarning()
      return
    }

    // Some terminals (e.g. kitty/wezterm with CSI-u keyboard protocol) encode Enter with modifiers as CSI u sequences.
    // Example: ESC[13;3u (Alt/Option+Enter). Ink may strip the leading ESC.
    if (/^(?:\x1b)?\[13;2(?:u|~)$/.test(input)) {
      // Shift+Enter -> newline in multiline chat inputs.
      const nextKey = {
        ...key,
        return: true,
        meta: false,
        shift: true,
      } as Key
      if (shouldBlockEnter(nextKey)) return
      onInput('\r', nextKey)
      return
    }
    if (/^(?:\x1b)?\[13;(?:3|4)(?:u|~)$/.test(input)) {
      // Alt/Option+Enter (or Shift+Alt/Option+Enter) -> newline in multiline chat inputs.
      const nextKey = { ...key, return: true, meta: true } as Key
      if (shouldBlockEnter(nextKey)) return
      onInput('\r', nextKey)
      return
    }

    // Some terminals emit LF ("\n") for Enter. Plain LF submits; modified LF
    // keeps the multiline-newline affordance.
    if (input === '\n') {
      if (__getLineFeedInputActionForTests({ multiline, key }) === 'newline') {
        if (shouldBlockEnter({ ...key, return: true } as Key)) return
        onInput('\n', key)
        return
      }

      const nextKey = { ...key, return: true } as Key
      if (shouldBlockEnter(nextKey)) return
      onInput('\r', nextKey)
      return
    }

    // Some terminals/keybindings emit ESC+CR/LF for Option+Enter. Depending on the decoder,
    // it may arrive as a raw 2-char sequence; treat it as Meta+Enter for multiline inputs.
    if (input === '\x1b\r' || input === '\x1b\n') {
      const nextKey = {
        ...key,
        return: true,
        meta: true,
      } as Key
      if (shouldBlockEnter(nextKey)) return
      onInput('\r', nextKey)
      return
    }

    if (key.paste && input) {
      const normalized = normalizeLineEndings(input)
      if (
        onPasteRef.current &&
        shouldTreatAsSpecialPaste(normalized, { terminalColumns: columns })
      ) {
        schedulePasteDelivery(normalized)
        return
      }

      onInput(normalized, key)
      return
    }

    // Check for special key combinations first
    if (onSpecialKey && onSpecialKey(input, key)) {
      // Special key was handled, don't process further
      return
    }

    if (key.delete && !key.backspace && !isBackspaceChar(input)) {
      onInput(input, {
        ...key,
        delete: true,
        backspace: false,
      })
      return
    }

    if (key.backspace || input === '\b' || isBackspaceChar(input)) {
      onInput(input, {
        ...key,
        backspace: true,
        delete: false,
      })
      return
    }

    // Bracketed paste mode: consume sequences and emit either special paste callback or normal insertion
    if (input && handleBracketedPasteSequences(input)) {
      armPasteGuard()
      return
    }

    // Handle paste-sized chunks before they enter React-rendered input.
    // Usually we get one or two input characters at a time. If we
    // get enough content to wrap across multiple prompt rows, the user has probably pasted.
    // Unfortunately node batches long pastes, so it's possible
    // that we would see e.g. 1024 characters and then just a few
    // more in the next frame that belong with the original paste.
    // This batching number is not consistent.
    const pasteAggregationDelay = onPaste
      ? __getPasteAggregationDelayForTests({
          input,
          hasPendingPaste: pasteTimeoutRef.current !== null,
          terminalColumns: columns,
        })
      : null

    if (onPaste && pasteAggregationDelay !== null) {
      armPasteGuard()
      pasteChunksRef.current.push(input)
      resetPasteTimeout(pasteAggregationDelay)
      return
    }

    if (shouldBlockEnter(key)) return
    onInput(input, key)
  }

  useKeypress(wrappedOnInput, { isActive: focus, priority: -10 })

  let renderedPlaceholder = placeholder
    ? chalk.hex(getTheme().secondaryText)(placeholder)
    : undefined

  // Fake mouse cursor, because we like punishment
  if (showCursor && focus) {
    renderedPlaceholder =
      placeholder.length > 0
        ? chalk.inverse(placeholder[0]) +
          chalk.hex(getTheme().secondaryText)(placeholder.slice(1))
        : chalk.inverse(' ')
  }

  const showPlaceholder = originalValue.length == 0 && placeholder
  const renderOverride =
    !showPlaceholder && typeof displayValue === 'string' ? displayValue : null

  const renderedOverrideValue =
    renderOverride && showCursor && focus
      ? renderOverride + chalk.inverse(' ')
      : renderOverride

  return (
    <Text wrap="truncate-end" dimColor={isDimmed}>
      {showPlaceholder
        ? renderedPlaceholder
        : (renderedOverrideValue ?? renderedValue)}
    </Text>
  )
}
