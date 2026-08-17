import { useCallback, useEffect, useRef } from 'react'
import { type Key } from '#ui-ink/hooks/useKeypress'
import { useDoublePress } from './useDoublePress'
import { Cursor } from '#cli-utils/Cursor'
import { normalizeLineEndings } from '#core/utils/paste'
import type {
  UseTextInputProps,
  UseTextInputResult,
} from './useTextInput.types'
import { mapInput } from './useTextInputMapping'
import { resolveImagePastePlaceholder } from './useTextInputTryImagePaste'

type MaybeCursor = void | Cursor

// Character codes - use numeric comparison to survive minification
const BACKSPACE_CODE = 8 // \x08
const DEL_CODE = 127 // \x7f

// IME (especially CJK) can emit cursor-navigation-like sequences around commits.
// A slightly longer guard helps prevent cursor jumps / wrong insertion points.
const IME_NAVIGATION_GUARD_MS = 150

function isBackspaceChar(input: string): boolean {
  if (input.length !== 1) return false
  const code = input.charCodeAt(0)
  return code === BACKSPACE_CODE || code === DEL_CODE
}

export function __resolveTextInputDestructiveActionForTests(
  key: Pick<Key, 'delete' | 'backspace'>,
  input: string,
): 'delete' | 'backspace' | null {
  if (key.delete && !key.backspace && !isBackspaceChar(input)) {
    return 'delete'
  }
  if (key.backspace || input === '\b' || isBackspaceChar(input)) {
    return 'backspace'
  }
  return null
}

export function useTextInput({
  value: originalValue,
  onChange,
  onSubmit,
  onExit,
  onExitMessage,
  onMessage,
  onHistoryUp,
  onHistoryDown,
  onHistoryReset,
  mask = '',
  multiline = false,
  cursorChar,
  invert,
  columns,
  maxHeight,
  onImagePaste,
  disableCursorMovementForUpDownKeys = false,
  externalOffset,
  onOffsetChange,
}: UseTextInputProps): UseTextInputResult {
  const offset = externalOffset
  const setOffset = onOffsetChange
  const cursorRef = useRef(Cursor.fromText(originalValue, columns, offset))
  const lastComplexInsertRef = useRef(0)
  const imagePasteInFlightRef = useRef(false)
  const isMountedRef = useRef(true)
  const imagePasteErrorTimeoutRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null)

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      if (imagePasteErrorTimeoutRef.current) {
        clearTimeout(imagePasteErrorTimeoutRef.current)
        imagePasteErrorTimeoutRef.current = null
      }
    }
  }, [])

  // Keep the cursor model in sync with external value/offset/columns updates.
  // Important: avoid recomputing wrapped layout unless the text or column count changed.
  const safeColumns = Math.max(1, columns - 1)
  const currentCursor = cursorRef.current
  if (
    currentCursor.measuredText.text !== originalValue ||
    currentCursor.measuredText.columns !== safeColumns
  ) {
    cursorRef.current = Cursor.fromText(originalValue, columns, offset)
  } else if (currentCursor.offset !== offset) {
    cursorRef.current = new Cursor(currentCursor.measuredText, offset)
  }

  function maybeClearImagePasteErrorTimeout(
    options: { hideMessage?: boolean } = {},
  ) {
    if (!imagePasteErrorTimeoutRef.current) {
      return
    }
    clearTimeout(imagePasteErrorTimeoutRef.current)
    imagePasteErrorTimeoutRef.current = null
    if (options.hideMessage !== false && isMountedRef.current) {
      onMessage?.(false)
    }
  }

  function scheduleImagePasteErrorClear() {
    maybeClearImagePasteErrorTimeout({ hideMessage: false })
    imagePasteErrorTimeoutRef.current = setTimeout(() => {
      imagePasteErrorTimeoutRef.current = null
      if (isMountedRef.current) onMessage?.(false)
    }, 4000)
  }

  function applyCursor(nextCursor: Cursor) {
    const previousCursor = cursorRef.current
    if (previousCursor.equals(nextCursor)) {
      return
    }
    cursorRef.current = nextCursor
    setOffset(nextCursor.offset)
    if (previousCursor.text !== nextCursor.text) {
      onChange(nextCursor.text)
    }
  }

  const handleCtrlC = useDoublePress(
    show => {
      maybeClearImagePasteErrorTimeout()
      onExitMessage?.(show, 'Ctrl-C')
    },
    () => onExit?.(),
    () => {
      if (originalValue) {
        onChange('')
        onHistoryReset?.()
      }
    },
  )

  // Keep Escape for clearing input
  const handleEscape = useDoublePress(
    show => {
      maybeClearImagePasteErrorTimeout()
      onMessage?.(!!originalValue && show, `Press Escape again to clear`)
    },
    () => {
      if (originalValue) {
        onChange('')
      }
    },
  )
  function clear() {
    return Cursor.fromText('', columns, 0)
  }

  const handleEmptyCtrlD = useDoublePress(
    show => onExitMessage?.(show, 'Ctrl-D'),
    () => onExit?.(),
  )

  function handleCtrlD(): MaybeCursor {
    maybeClearImagePasteErrorTimeout()
    const currentCursor = cursorRef.current
    if (currentCursor.text === '') {
      // When input is empty, handle double-press
      handleEmptyCtrlD()
      return currentCursor
    }
    // When input is not empty, delete forward like iPython
    return currentCursor.del()
  }

  function handleImagePaste(): MaybeCursor {
    if (imagePasteInFlightRef.current) {
      return cursorRef.current
    }

    imagePasteInFlightRef.current = true
    void resolveImagePastePlaceholder({
      mask,
      onImagePaste,
      onMessage,
      clearImagePasteErrorTimeout: maybeClearImagePasteErrorTimeout,
      scheduleImagePasteErrorClear,
    })
      .then(placeholder => {
        imagePasteInFlightRef.current = false
        if (!isMountedRef.current || !placeholder) return
        applyCursor(cursorRef.current.insert(placeholder))
      })
      .catch(() => {
        imagePasteInFlightRef.current = false
      })

    return cursorRef.current
  }

  function getCursor(): Cursor {
    return cursorRef.current
  }

  function shouldSuppressNavigation(): boolean {
    const last = lastComplexInsertRef.current
    return last > 0 && Date.now() - last < IME_NAVIGATION_GUARD_MS
  }

  const handleCtrl = mapInput<MaybeCursor>(
    [
      ['a', () => getCursor().startOfLine()],
      ['b', () => getCursor().left()],
      ['c', handleCtrlC],
      ['d', handleCtrlD],
      ['e', () => getCursor().endOfLine()],
      ['f', () => getCursor().right()],
      [
        'h',
        () => {
          maybeClearImagePasteErrorTimeout()
          return getCursor().backspace()
        },
      ],
      // Cross-terminal multiline fallback (Ctrl+J is LF on many systems).
      ['j', () => (multiline ? getCursor().insert('\n') : undefined)],
      ['k', () => getCursor().deleteToLineEnd()],
      ['l', () => clear()],
      ['n', () => downOrHistoryDown()],
      ['p', () => upOrHistoryUp()],
      ['u', () => getCursor().deleteToLineStart()],
      ['v', handleImagePaste],
      ['w', () => getCursor().deleteWordBefore()],
    ],
    () => undefined,
  )

  const handleMeta = mapInput<MaybeCursor>(
    [
      ['b', () => getCursor().prevWord()],
      ['f', () => getCursor().nextWord()],
      ['d', () => getCursor().deleteWordAfter()],
    ],
    () => undefined,
  )

  function handleEnter(key: Key) {
    if (!multiline) {
      onSubmit?.(getCursor().text)
      return undefined
    }

    // Multiline chat input: Enter submits, Shift+Enter and Option/Alt+Enter insert newline.
    const optionPressed = (() => {
      if (!('option' in key)) return false
      const optionValue = (key as unknown as Record<string, unknown>).option
      return optionValue === true
    })()
    const sequence = typeof key.sequence === 'string' ? key.sequence : ''
    const modifierEnterSequence =
      // kitty/CSI-u: ESC[13;2u (shift) / ESC[13;3u (alt) / ESC[13;4u (shift+alt)
      /^\x1b\[13;[234](?:u|~)$/.test(sequence) ||
      // modifyOtherKeys: CSI 27 ; modifier ; 13 ~
      /^\x1b\[27;[234];13~$/.test(sequence) ||
      // Some terminals encode Shift+Enter as CSI 13 $
      /^\x1b\[13\$$/.test(sequence) ||
      // Alt/Option+Enter may arrive as ESC-prefixed CR/LF
      sequence === '\x1b\r' ||
      sequence === '\x1b\n' ||
      // Windows Terminal: Ctrl+Enter (CSI 13;5u)
      /^\x1b\[13;5u$/.test(sequence) ||
      // Windows ConPTY variations
      sequence === '\x1bOM' ||
      sequence === '\x1b[13;2~'

    // Also support Ctrl+Enter on Windows (key.ctrl with return)
    if (
      key.shift ||
      key.meta ||
      key.ctrl ||
      optionPressed ||
      modifierEnterSequence
    ) {
      return getCursor().insert('\n')
    }

    onSubmit?.(getCursor().text)
    return undefined
  }

  function shouldDisableCursorMovement(): boolean {
    if (typeof disableCursorMovementForUpDownKeys === 'function') {
      return disableCursorMovementForUpDownKeys()
    }
    return disableCursorMovementForUpDownKeys ?? false
  }

  function upOrHistoryUp() {
    if (shouldDisableCursorMovement()) {
      onHistoryUp?.()
      return getCursor()
    }
    const currentCursor = getCursor()
    const { line } = currentCursor.measuredText.getPositionFromOffset(
      currentCursor.offset,
    )

    // If on first line, navigate history instead of moving cursor
    if (line === 0) {
      onHistoryUp?.()
      return currentCursor
    }

    // Move cursor up within text
    return currentCursor.up()
  }

  function downOrHistoryDown() {
    if (shouldDisableCursorMovement()) {
      onHistoryDown?.()
      return getCursor()
    }
    const currentCursor = getCursor()
    const { line } = currentCursor.measuredText.getPositionFromOffset(
      currentCursor.offset,
    )
    const lastLine = currentCursor.measuredText.lineCount - 1

    // If on last line, navigate history instead of moving cursor
    if (line >= lastLine) {
      onHistoryDown?.()
      return currentCursor
    }

    // Move cursor down within text
    return currentCursor.down()
  }

  function onInput(input: string, key: Key): void {
    if (key.tab) {
      return // Skip Tab key processing - let completion system handle it
    }

    const destructive = __resolveTextInputDestructiveActionForTests(key, input)
    if (destructive === 'delete') {
      applyCursor(getCursor().del())
      return
    }
    if (destructive === 'backspace') {
      applyCursor(getCursor().backspace())
      return
    }

    const isInsertable = key.insertable && !key.ctrl && !key.meta
    if (isInsertable) {
      const now = Date.now()
      const hasNonAscii = /[^\x00-\x7f]/.test(input)
      const isComplexInsert = input.length > 1 || hasNonAscii
      if (isComplexInsert) {
        lastComplexInsertRef.current = now
      }
    }

    // Handle paste operations - process large input strings more efficiently
    // This prevents cursor position issues when pasting into masked fields
    if (!key.ctrl && !key.meta && input.length > 1) {
      // Likely a paste operation
      const normalized = normalizeLineEndings(input)
      const insertText = multiline ? normalized : normalized.replace(/\n/g, ' ')
      applyCursor(getCursor().insert(insertText))
      return
    }

    const nextCursor = mapKey(key)(input)
    if (nextCursor) {
      applyCursor(nextCursor)
    }
  }

  function mapKey(key: Key): (input: string) => MaybeCursor {
    const destructive = __resolveTextInputDestructiveActionForTests(key, '')
    if (destructive === 'delete') {
      maybeClearImagePasteErrorTimeout()
      return () => getCursor().del()
    }
    if (destructive === 'backspace') {
      maybeClearImagePasteErrorTimeout()
      return () => getCursor().backspace()
    }

    switch (true) {
      case key.escape:
        return handleEscape
      case key.leftArrow && (key.ctrl || key.meta || ('fn' in key && key.fn)):
        return shouldSuppressNavigation()
          ? () => getCursor()
          : () => getCursor().prevWord()
      case key.rightArrow && (key.ctrl || key.meta || ('fn' in key && key.fn)):
        return shouldSuppressNavigation()
          ? () => getCursor()
          : () => getCursor().nextWord()
      case key.ctrl:
        return handleCtrl
      case 'home' in key && key.home:
        return shouldSuppressNavigation()
          ? () => getCursor()
          : () => getCursor().startOfLine()
      case 'end' in key && key.end:
        return shouldSuppressNavigation()
          ? () => getCursor()
          : () => getCursor().endOfLine()
      case key.pageDown:
        return shouldSuppressNavigation()
          ? () => getCursor()
          : () => getCursor().endOfLine()
      case key.pageUp:
        return shouldSuppressNavigation()
          ? () => getCursor()
          : () => getCursor().startOfLine()
      case key.return:
        return () => handleEnter(key)
      case key.meta:
        return handleMeta
      // Remove Tab handling - let completion system handle it
      case key.upArrow:
        return shouldSuppressNavigation() ? () => getCursor() : upOrHistoryUp
      case key.downArrow:
        return shouldSuppressNavigation()
          ? () => getCursor()
          : downOrHistoryDown
      case key.leftArrow:
        return shouldSuppressNavigation()
          ? () => getCursor()
          : () => getCursor().left()
      case key.rightArrow:
        return shouldSuppressNavigation()
          ? () => getCursor()
          : () => getCursor().right()
    }
    return function (input: string) {
      switch (true) {
        // Home key
        case input == '\x1b[H' || input == '\x1b[1~':
          return getCursor().startOfLine()
        // End key
        case input == '\x1b[F' || input == '\x1b[4~':
          return getCursor().endOfLine()
        // Handle backspace character explicitly - this is the key fix
        case input === '\b' || isBackspaceChar(input):
          maybeClearImagePasteErrorTimeout()
          return getCursor().backspace()
        default:
          return getCursor().insert(input.replace(/\r/g, '\n'))
      }
    }
  }

  const getCurrentInputState = useCallback(
    () => ({
      value: cursorRef.current.text,
      cursorOffset: cursorRef.current.offset,
    }),
    [],
  )

  return {
    onInput,
    renderedValue: cursorRef.current.render(cursorChar, mask, invert, {
      maxHeight,
    }),
    offset,
    setOffset,
    getCurrentInputState,
  }
}
