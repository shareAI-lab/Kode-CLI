import { useStdin } from 'ink'
import * as React from 'react'
import { useCallback, useEffect, useRef } from 'react'
import ReactReconciler from 'react-reconciler'
import { debug as debugLogger } from '#core/utils/debugLogger'
import { terminalCapabilityManager } from '#ui-ink/utils/terminalCapabilityManager'
import { disableMouseEvents, enableMouseEvents } from '#cli-utils/terminal'

export const BACKSLASH_ENTER_TIMEOUT = 5
export const ESC_TIMEOUT = 50
export const PASTE_TIMEOUT = 30_000
export const FAST_RETURN_TIMEOUT = 30
// Only protect fast Return after paste-like chunks; normal typing must submit immediately.
const FAST_RETURN_PASTE_LIKE_CHARS = 80
export const PASTE_PROTECTION_RETURN_KEY_NAME = 'paste-protection-return'

const ESC = '\x1b'

// Character codes - use numeric comparison to survive minification
const BACKSPACE_CODE = 8 // \x08 / \b
const BEL_CODE = 7 // \x07 / \u0007 (BEL)
const DEL_CODE = 127 // \x7f
const UNIT_SEPARATOR_CODE = 31 // \x1f (Ctrl+_)
const CTRL_Z_CODE = 26 // \x1a (highest control char for Ctrl+letter)

const batchedUpdates: ((fn: () => void) => void) | null =
  typeof (ReactReconciler as any)?.batchedUpdates === 'function'
    ? ((ReactReconciler as any).batchedUpdates as (fn: () => void) => void)
    : typeof (ReactReconciler as any)?.default?.batchedUpdates === 'function'
      ? ((ReactReconciler as any).default.batchedUpdates as (
          fn: () => void,
        ) => void)
      : null

// Some macOS terminals emit special characters for Option/Alt-modified keys instead of ESC-prefixed sequences.
// Map a small set of common cases back into Meta+<key> so navigation shortcuts work consistently.
const MAC_ALT_KEY_CHARACTER_MAP: Record<string, string> = {
  '\u222B': 'b', // ∫  -> Meta+b (prev word)
  '\u0192': 'f', // ƒ  -> Meta+f (next word)
  '\u00B5': 'm', // µ  -> Meta+m (toggle model / misc)
  '\u03BC': 'm', // μ  -> Meta+m (some terminals emit Greek mu)
}

const KEY_INFO_MAP: Record<
  string,
  { name: string; shift?: boolean; ctrl?: boolean }
> = {
  '[200~': { name: 'paste-start' },
  '[201~': { name: 'paste-end' },
  '[[A': { name: 'f1' },
  '[[B': { name: 'f2' },
  '[[C': { name: 'f3' },
  '[[D': { name: 'f4' },
  '[[E': { name: 'f5' },
  '[1~': { name: 'home' },
  '[2~': { name: 'insert' },
  '[3~': { name: 'delete' },
  '[4~': { name: 'end' },
  '[5~': { name: 'pageup' },
  '[6~': { name: 'pagedown' },
  '[7~': { name: 'home' },
  '[8~': { name: 'end' },
  '[11~': { name: 'f1' },
  '[12~': { name: 'f2' },
  '[13~': { name: 'f3' },
  '[14~': { name: 'f4' },
  '[15~': { name: 'f5' },
  '[17~': { name: 'f6' },
  '[18~': { name: 'f7' },
  '[19~': { name: 'f8' },
  '[20~': { name: 'f9' },
  '[21~': { name: 'f10' },
  '[23~': { name: 'f11' },
  '[24~': { name: 'f12' },
  '[A': { name: 'up' },
  '[B': { name: 'down' },
  '[C': { name: 'right' },
  '[D': { name: 'left' },
  '[E': { name: 'clear' },
  '[F': { name: 'end' },
  '[H': { name: 'home' },
  '[P': { name: 'f1' },
  '[Q': { name: 'f2' },
  '[R': { name: 'f3' },
  '[S': { name: 'f4' },
  OA: { name: 'up' },
  OB: { name: 'down' },
  OC: { name: 'right' },
  OD: { name: 'left' },
  OE: { name: 'clear' },
  OF: { name: 'end' },
  OH: { name: 'home' },
  OP: { name: 'f1' },
  OQ: { name: 'f2' },
  OR: { name: 'f3' },
  OS: { name: 'f4' },
  '[[5~': { name: 'pageup' },
  '[[6~': { name: 'pagedown' },
  '[9u': { name: 'tab' },
  '[13u': { name: 'return' },
  '[13$': { name: 'return', shift: true },
  '[13^': { name: 'return', ctrl: true },
  '[27u': { name: 'escape' },
  '[127u': { name: 'backspace' },
  '[57414u': { name: 'return' }, // Numpad Enter
  // Reverse tab / modified cursor keys used by some terminals
  '[Z': { name: 'tab', shift: true },
  '[a': { name: 'up', shift: true },
  '[b': { name: 'down', shift: true },
  '[c': { name: 'right', shift: true },
  '[d': { name: 'left', shift: true },
  '[e': { name: 'clear', shift: true },
  '[2$': { name: 'insert', shift: true },
  '[3$': { name: 'delete', shift: true },
  '[5$': { name: 'pageup', shift: true },
  '[6$': { name: 'pagedown', shift: true },
  '[7$': { name: 'home', shift: true },
  '[8$': { name: 'end', shift: true },
  Oa: { name: 'up', ctrl: true },
  Ob: { name: 'down', ctrl: true },
  Oc: { name: 'right', ctrl: true },
  Od: { name: 'left', ctrl: true },
  Oe: { name: 'clear', ctrl: true },
  '[2^': { name: 'insert', ctrl: true },
  '[3^': { name: 'delete', ctrl: true },
  '[5^': { name: 'pageup', ctrl: true },
  '[6^': { name: 'pagedown', ctrl: true },
  '[7^': { name: 'home', ctrl: true },
  '[8^': { name: 'end', ctrl: true },
}

export type Key = {
  sequence: string
  name: string
  ctrl: boolean
  meta: boolean
  shift: boolean
  paste: boolean
  insertable: boolean
  upArrow?: boolean
  downArrow?: boolean
  leftArrow?: boolean
  rightArrow?: boolean
  return?: boolean
  tab?: boolean
  escape?: boolean
  backspace?: boolean
  delete?: boolean
  pageUp?: boolean
  pageDown?: boolean
  home?: boolean
  end?: boolean
  option?: boolean
  fn?: boolean
}

type ParsedKey = {
  name: string
  ctrl: boolean
  meta: boolean
  shift: boolean
  paste: boolean
  insertable: boolean
  sequence: string
}

type KeypressHandler = (
  input: string,
  key: Key,
) => boolean | void | Promise<boolean | void | undefined>
type KeypressSubscribeOptions = { priority?: number }

export type TerminalMouseButton =
  'left' | 'middle' | 'right' | 'wheel-up' | 'wheel-down' | 'unknown'

export type TerminalMouseEvent = {
  type: 'press' | 'release' | 'scroll'
  button: TerminalMouseButton
  x: number
  y: number
  ctrl: boolean
  meta: boolean
  shift: boolean
  rawCode: number
  sequence: string
}

type MouseHandler = (
  event: TerminalMouseEvent,
) => boolean | void | Promise<void>
type MouseSubscribeOptions = { priority?: number }

function bufferBackslashEnter(keypressHandler: (key: ParsedKey) => void) {
  const bufferer = (function* (): Generator<void, void, ParsedKey | null> {
    while (true) {
      const key = yield

      if (key == null) {
        continue
      } else if (key.sequence !== '\\') {
        keypressHandler(key)
        continue
      }

      const timeoutId = setTimeout(
        () => bufferer.next(null),
        BACKSLASH_ENTER_TIMEOUT,
      )
      const nextKey = yield
      clearTimeout(timeoutId)

      if (nextKey === null) {
        keypressHandler(key)
      } else if (nextKey.name === 'return') {
        keypressHandler({
          ...nextKey,
          shift: true,
          sequence: '\r',
        })
      } else {
        keypressHandler(key)
        keypressHandler(nextKey)
      }
    }
  })()

  bufferer.next()

  return (key: ParsedKey) => bufferer.next(key)
}

function bufferFastReturn(
  keypressHandler: (key: ParsedKey) => void,
  shouldProtectFastReturn: () => boolean,
) {
  let lastKeyTime = 0
  let lastKey: ParsedKey | null = null
  return (key: ParsedKey) => {
    const now = Date.now()
    const isFastDuplicateReturn =
      key.name === 'return' &&
      !key.ctrl &&
      !key.meta &&
      !key.shift &&
      lastKey?.name === 'return' &&
      !lastKey.ctrl &&
      !lastKey.meta &&
      !lastKey.shift &&
      now - lastKeyTime <= FAST_RETURN_TIMEOUT
    const previousLooksLikePaste =
      lastKey?.insertable === true &&
      !lastKey.ctrl &&
      !lastKey.meta &&
      (lastKey.sequence.includes('\n') ||
        lastKey.sequence.includes('\r') ||
        lastKey.sequence.length >= FAST_RETURN_PASTE_LIKE_CHARS)

    if (isFastDuplicateReturn) {
      // Windows/ConPTY can deliver one Return burst in adjacent stdin chunks.
      // Keep one logical Enter so async submit handlers cannot see the same text twice.
      lastKey = key
      lastKeyTime = now
      return
    }

    if (
      shouldProtectFastReturn() &&
      key.name === 'return' &&
      previousLooksLikePaste &&
      now - lastKeyTime <= FAST_RETURN_TIMEOUT
    ) {
      keypressHandler({
        ...key,
        name: PASTE_PROTECTION_RETURN_KEY_NAME,
        sequence: '\r',
        paste: true,
        insertable: false,
      })
    } else {
      keypressHandler(key)
    }
    lastKey = key
    lastKeyTime = now
  }
}

function bufferPaste(keypressHandler: (key: ParsedKey) => void) {
  const bufferer = (function* (): Generator<void, void, ParsedKey | null> {
    while (true) {
      let key = yield

      if (key === null) {
        continue
      } else if (key.name !== 'paste-start') {
        keypressHandler(key)
        continue
      }

      let buffer = ''
      while (true) {
        const timeoutId = setTimeout(() => bufferer.next(null), PASTE_TIMEOUT)
        key = yield
        clearTimeout(timeoutId)

        if (key === null) {
          break
        }

        if (key.name === 'paste-end') {
          break
        }
        buffer += key.sequence
      }

      if (buffer.length > 0) {
        keypressHandler({
          name: '',
          ctrl: false,
          meta: false,
          shift: false,
          paste: true,
          insertable: true,
          sequence: buffer,
        })
      }
    }
  })()
  bufferer.next()

  return (key: ParsedKey) => bufferer.next(key)
}

type StdinChunkSegment = {
  data: string
  bulk: boolean
}

function segmentStdinChunk(data: string): StdinChunkSegment[] {
  if (data.length === 0) return []

  const hasEsc = data.includes(ESC)
  const hasDisallowedControlChars =
    // eslint-disable-next-line no-control-regex
    /[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/.test(data)
  const looksLikeEscapeContinuation =
    (data.startsWith('[') && /^\[[0-9;]*[~^$uA-Za-z]$/.test(data)) ||
    (data.startsWith('O') && /^O[0-9]?[A-Za-z]$/.test(data))

  const trailingReturns = /(?:\r\n|\r|\n)+$/.exec(data)?.[0]
  const textBeforeReturns = trailingReturns
    ? data.slice(0, -trailingReturns.length)
    : ''
  const canSplitTrailingReturnBurst =
    data.length > 1 &&
    !hasEsc &&
    !hasDisallowedControlChars &&
    !looksLikeEscapeContinuation &&
    trailingReturns !== undefined &&
    trailingReturns.includes('\r') &&
    !textBeforeReturns.includes('\r') &&
    !textBeforeReturns.includes('\n')

  if (canSplitTrailingReturnBurst) {
    const segments: StdinChunkSegment[] = []
    if (textBeforeReturns.length > 0) {
      segments.push({
        data: textBeforeReturns,
        bulk: textBeforeReturns.length > 1,
      })
    }
    segments.push({
      data: trailingReturns.replace(/\r\n|\n/g, '\r'),
      bulk: false,
    })
    return segments
  }

  return [
    {
      data,
      bulk:
        data.length > 1 &&
        !hasEsc &&
        !hasDisallowedControlChars &&
        !looksLikeEscapeContinuation,
    },
  ]
}

function createDataListener(
  keypressHandler: (key: ParsedKey) => void,
  mouseHandler?: (event: TerminalMouseEvent) => void,
): (data: string) => void {
  const parser = emitKeys(keypressHandler, mouseHandler)
  parser.next()

  let timeoutId: NodeJS.Timeout
  return (data: string) => {
    clearTimeout(timeoutId)

    // Preserve bulk insertion for multiline paste and IME commits, but split a
    // terminal Return burst so its leading text and Enter keep distinct semantics.
    for (const segment of segmentStdinChunk(data)) {
      if (segment.bulk) {
        // Flush any pending ESC prefix before injecting a bulk insert.
        parser.next('')
        parser.next(segment.data)
      } else {
        for (const char of segment.data) {
          parser.next(char)
        }
      }
    }

    if (data.length !== 0) {
      timeoutId = setTimeout(() => parser.next(''), ESC_TIMEOUT)
    }
  }
}

function createKeypressDataListener(
  keypressHandler: (key: ParsedKey) => void,
  mouseHandler: ((event: TerminalMouseEvent) => void) | undefined,
  shouldProtectFastReturn: () => boolean,
): (data: string) => void {
  let processor = bufferFastReturn(keypressHandler, shouldProtectFastReturn)
  processor = bufferBackslashEnter(processor)
  processor = bufferPaste(processor)

  return createDataListener(processor, mouseHandler)
}

function parseSgrMouseEvent(
  body: string,
  finalChar: 'M' | 'm',
  sequence: string,
): TerminalMouseEvent | null {
  const parts = body.split(';')
  if (parts.length !== 3) return null

  const rawCode = Number.parseInt(parts[0] ?? '', 10)
  const x = Number.parseInt(parts[1] ?? '', 10)
  const y = Number.parseInt(parts[2] ?? '', 10)
  if (!Number.isFinite(rawCode) || !Number.isFinite(x) || !Number.isFinite(y)) {
    return null
  }

  const isWheel = Boolean(rawCode & 64)
  const buttonBits = rawCode & 3
  const button: TerminalMouseButton = isWheel
    ? buttonBits === 0
      ? 'wheel-up'
      : buttonBits === 1
        ? 'wheel-down'
        : 'unknown'
    : buttonBits === 0
      ? 'left'
      : buttonBits === 1
        ? 'middle'
        : buttonBits === 2
          ? 'right'
          : 'unknown'

  return {
    type: isWheel ? 'scroll' : finalChar === 'm' ? 'release' : 'press',
    button,
    x,
    y,
    ctrl: Boolean(rawCode & 16),
    meta: Boolean(rawCode & 8),
    shift: Boolean(rawCode & 4),
    rawCode,
    sequence,
  }
}

function* emitKeys(
  keypressHandler: (key: ParsedKey) => void,
  mouseHandler?: (event: TerminalMouseEvent) => void,
): Generator<void, void, string> {
  while (true) {
    let ch = yield
    let sequence = ch
    let escaped = false

    let name = ''
    let ctrl = false
    let meta = false
    let shift = false
    let code = ''
    let insertable = false

    if (ch === ESC) {
      escaped = true
      ch = yield
      sequence += ch

      if (ch === ESC) {
        ch = yield
        sequence += ch
      }
    }

    if (escaped && (ch === 'O' || ch === '[' || ch === ']')) {
      code = ch
      let modifier = 0

      if (ch === ']') {
        let buffer = ''
        while (true) {
          const next = yield
          if (
            next === '' ||
            (next.length === 1 && next.charCodeAt(0) === BEL_CODE)
          ) {
            break
          } else if (next === ESC) {
            const afterEsc = yield
            if (afterEsc === '' || afterEsc === '\\') {
              break
            }
            buffer += next + afterEsc
            continue
          }
          buffer += next
        }

        continue
      } else if (ch === 'O') {
        ch = yield
        sequence += ch

        if (ch >= '0' && ch <= '9') {
          modifier = Number.parseInt(ch, 10) - 1
          ch = yield
          sequence += ch
        }

        code += ch
      } else if (ch === '[') {
        ch = yield
        sequence += ch

        if (ch === '[') {
          code += ch
          ch = yield
          sequence += ch
        }

        if (ch === '<') {
          let mouseBody = ''
          while (true) {
            ch = yield
            if (ch === '') {
              break
            }
            sequence += ch

            if (ch === 'M' || ch === 'm') {
              const mouseEvent = parseSgrMouseEvent(mouseBody, ch, sequence)
              if (mouseEvent) mouseHandler?.(mouseEvent)
              break
            }

            if ((ch >= '0' && ch <= '9') || ch === ';') {
              mouseBody += ch
              continue
            }

            break
          }

          continue
        }

        const cmdStart = sequence.length - 1

        while (ch >= '0' && ch <= '9') {
          ch = yield
          sequence += ch
        }

        while (ch === ';') {
          ch = yield
          sequence += ch

          while (ch >= '0' && ch <= '9') {
            ch = yield
            sequence += ch
          }
        }

        const cmd = sequence.substring(cmdStart)
        let match: RegExpExecArray | null

        if ((match = /^(\d+)(?:;(\d+))?(?:;(\d+))?([~^$u])$/.exec(cmd))) {
          const isReleaseEvent =
            // kitty keyboard protocol can include an event type as the 3rd param: 1=press, 2=repeat, 3=release.
            // Ignore release events to avoid double-triggering shortcuts.
            match[4] === 'u' && match[3] === '3' && match[1] !== '27'
          const isReturnRepeatEvent =
            match[4] === 'u' &&
            match[3] === '2' &&
            (match[1] === '13' || match[1] === '57414')
          if (isReleaseEvent || isReturnRepeatEvent) {
            continue
          }
          if (match[1] === '27' && match[3] && match[4] === '~') {
            // modifyOtherKeys format: CSI 27 ; modifier ; key ~
            // Treat as CSI u: key + 'u'
            code += match[3] + 'u'
            modifier = Number.parseInt(match[2] ?? '1', 10) - 1
          } else if (match[1] === '13' && match[2] && match[4] === '~') {
            // Some terminals encode modified Enter as CSI 13 ; <modifier> ~.
            // Normalize to CSI-u so downstream handlers see it as a Return key.
            code += match[1] + 'u'
            modifier = Number.parseInt(match[2], 10) - 1
          } else {
            code += match[1]! + match[4]!
            modifier = Number.parseInt(match[2] ?? '1', 10) - 1
          }
        } else if ((match = /^(\d+)?(?:;(\d+))?([A-Za-z])$/.exec(cmd))) {
          code += match[3]!
          modifier = Number.parseInt(match[2] ?? match[1] ?? '1', 10) - 1
        } else {
          code += cmd
        }
      }

      ctrl = Boolean(modifier & 4)
      meta = Boolean(modifier & 10)
      shift = Boolean(modifier & 1)

      const keyInfo = KEY_INFO_MAP[code]
      if (keyInfo) {
        name = keyInfo.name
        if (keyInfo.shift) shift = true
        if (keyInfo.ctrl) ctrl = true
      } else {
        name = 'undefined'
        if (
          code.startsWith('[') &&
          (code.endsWith('u') || code.endsWith('~')) &&
          /^\[\d+(?:u|~)$/.test(code)
        ) {
          const codeNumber = Number.parseInt(code.slice(1, -1), 10)
          if (Number.isFinite(codeNumber) && codeNumber > 0) {
            try {
              // CSI-u (kitty/modifyOtherKeys) can report printable keys as numeric codepoints.
              // Map codepoints back to characters so normal typing works when a terminal chooses
              // to encode unmodified keys using CSI-u.
              const ch = String.fromCodePoint(codeNumber)
              const isControl =
                // eslint-disable-next-line no-control-regex
                /[\x00-\x1f\x7f]/.test(ch)

              if (!isControl) {
                // Match the behavior of the non-escape path: letters/digits set name, others
                // are insertable with an empty name.
                if (/^[A-Z]$/.test(ch)) {
                  name = ch.toLowerCase()
                  shift = true
                } else if (/^[a-z0-9]$/.test(ch)) {
                  name = ch
                } else {
                  name = ''
                }

                // If there are no modifiers, treat it as normal insertable input.
                // For Ctrl/Meta-modified codepoints, downstream handlers use `name`.
                if (!ctrl && !meta) {
                  insertable = true
                  sequence = ch
                }
              }
            } catch {
              // ignore
            }
          }
        }
      }
    } else if (ch === '\r') {
      name = 'return'
      meta = escaped
    } else if (escaped && ch === '\n') {
      // Some terminals encode Alt/Option+Enter as ESC + LF.
      // Treat it like Alt+Enter (Meta+Return) rather than Ctrl+J.
      name = 'return'
      meta = escaped
    } else if (ch === '\t') {
      name = 'tab'
      meta = escaped
    } else if (ch === '\b' || ch.charCodeAt(0) === DEL_CODE) {
      name = 'backspace'
      meta = escaped
    } else if (!escaped && ch.charCodeAt(0) === UNIT_SEPARATOR_CODE) {
      // Ctrl+_ (unit separator) is commonly used as an "undo" shortcut.
      // Treat it like other Ctrl+<key> combos so downstream handlers can bind it.
      name = '_'
      ctrl = true
    } else if (ch === ESC) {
      name = 'escape'
      meta = escaped
    } else if (ch === ' ') {
      name = 'space'
      meta = escaped
      insertable = true
    } else if (!escaped && ch.length === 1 && ch.charCodeAt(0) <= CTRL_Z_CODE) {
      name = String.fromCharCode(ch.charCodeAt(0) + 'a'.charCodeAt(0) - 1)
      ctrl = true
    } else if (/^[0-9A-Za-z]$/.exec(ch) !== null) {
      name = ch.toLowerCase()
      shift = /^[A-Z]$/.exec(ch) !== null
      meta = escaped
      insertable = true
    } else if (process.platform === 'darwin' && MAC_ALT_KEY_CHARACTER_MAP[ch]) {
      name = MAC_ALT_KEY_CHARACTER_MAP[ch]!
      meta = true
    } else if (sequence === `${ESC}${ESC}`) {
      name = 'escape'
      meta = true

      keypressHandler({
        name: 'escape',
        ctrl,
        meta,
        shift,
        paste: false,
        insertable: false,
        sequence: ESC,
      })
    } else if (escaped) {
      name = ch.length ? '' : 'escape'
      meta = true
    } else {
      insertable = true
    }

    if (sequence.length !== 0) {
      keypressHandler({
        name,
        ctrl,
        meta,
        shift,
        paste: false,
        insertable,
        sequence,
      })
    }
  }
}

function buildKey(parsed: ParsedKey): Key {
  const name = parsed.name
  const key: Key = {
    sequence: parsed.sequence,
    name,
    ctrl: parsed.ctrl,
    meta: parsed.meta,
    shift: parsed.shift,
    paste: parsed.paste,
    insertable: parsed.insertable,
  }

  key.upArrow = name === 'up'
  key.downArrow = name === 'down'
  key.leftArrow = name === 'left'
  key.rightArrow = name === 'right'
  key.return = name === 'return' || name === 'enter'
  key.tab = name === 'tab'
  key.escape = name === 'escape'
  key.backspace = name === 'backspace'
  key.delete = name === 'delete'
  key.pageUp = name === 'pageup'
  key.pageDown = name === 'pagedown'
  key.home = name === 'home'
  key.end = name === 'end'
  key.option = process.platform === 'darwin' ? parsed.meta : undefined
  key.fn = false

  return key
}

function keyToInput(parsed: ParsedKey): string {
  if (parsed.ctrl && parsed.name && parsed.name.length === 1) {
    return parsed.name
  }
  if (parsed.meta && parsed.name && parsed.name.length === 1) {
    return parsed.name
  }
  if (parsed.paste) {
    return parsed.sequence
  }
  if (parsed.insertable) {
    // For Meta/Alt-modified "printable" keys, many terminals send ESC + <char>.
    // Downstream keymaps (e.g. Meta+b / Meta+f word navigation) expect the raw character.
    if (parsed.meta && parsed.sequence.startsWith(ESC)) {
      return parsed.sequence.slice(1)
    }
    return parsed.sequence
  }
  return ''
}

export function __createKeypressDataListenerForTests(
  handler: (input: string, key: Key) => void,
  options: { protectFastReturn?: boolean } = {},
): (data: string) => void {
  return createKeypressDataListener(
    parsed => {
      handler(keyToInput(parsed), buildKey(parsed))
    },
    undefined,
    () => options.protectFastReturn ?? false,
  )
}

interface KeypressContextValue {
  subscribe: (
    handler: KeypressHandler,
    options?: KeypressSubscribeOptions,
  ) => void
  unsubscribe: (handler: KeypressHandler) => void
  subscribeMouse: (
    handler: MouseHandler,
    options?: MouseSubscribeOptions,
  ) => void
  unsubscribeMouse: (handler: MouseHandler) => void
}

const KeypressContext = React.createContext<KeypressContextValue | undefined>(
  undefined,
)

export function useKeypressContext() {
  const context = React.useContext(KeypressContext)
  if (!context) {
    throw new Error('useKeypressContext must be used within KeypressProvider')
  }
  return context
}

export function KeypressProvider({
  children,
  debugKeystrokeLogging,
}: {
  children: React.ReactNode
  debugKeystrokeLogging?: boolean
}) {
  const { stdin, setRawMode, isRawModeSupported } = useStdin()

  type Subscription<THandler> = {
    handler: THandler
    priority: number
    order: number
  }

  const subscriptionsRef = useRef<
    Map<KeypressHandler, Subscription<KeypressHandler>>
  >(new Map())
  const orderedSubscriptionsRef = useRef<Subscription<KeypressHandler>[]>([])
  const mouseSubscriptionsRef = useRef<
    Map<MouseHandler, Subscription<MouseHandler>>
  >(new Map())
  const orderedMouseSubscriptionsRef = useRef<Subscription<MouseHandler>[]>([])
  const nextOrderRef = useRef(0)

  const rebuildOrderedSubscriptions = useCallback(() => {
    orderedSubscriptionsRef.current = [
      ...subscriptionsRef.current.values(),
    ].sort((a, b) => b.priority - a.priority || b.order - a.order)
  }, [])

  const rebuildOrderedMouseSubscriptions = useCallback(() => {
    orderedMouseSubscriptionsRef.current = [
      ...mouseSubscriptionsRef.current.values(),
    ].sort((a, b) => b.priority - a.priority || b.order - a.order)
  }, [])

  const subscribe = useCallback(
    (handler: KeypressHandler, options?: KeypressSubscribeOptions) => {
      if (subscriptionsRef.current.has(handler)) {
        // Defensive: if a handler re-subscribes, update its priority.
        const current = subscriptionsRef.current.get(handler)
        if (current) {
          current.priority = options?.priority ?? 0
          subscriptionsRef.current.set(handler, current)
          rebuildOrderedSubscriptions()
        }
        return
      }

      const subscription: Subscription<KeypressHandler> = {
        handler,
        priority: options?.priority ?? 0,
        order: nextOrderRef.current++,
      }
      subscriptionsRef.current.set(handler, subscription)
      rebuildOrderedSubscriptions()
    },
    [rebuildOrderedSubscriptions],
  )

  const unsubscribe = useCallback(
    (handler: KeypressHandler) => {
      const didDelete = subscriptionsRef.current.delete(handler)
      if (didDelete) {
        rebuildOrderedSubscriptions()
      }
    },
    [rebuildOrderedSubscriptions],
  )

  const subscribeMouse = useCallback(
    (handler: MouseHandler, options?: MouseSubscribeOptions) => {
      if (mouseSubscriptionsRef.current.has(handler)) {
        const current = mouseSubscriptionsRef.current.get(handler)
        if (current) {
          current.priority = options?.priority ?? 0
          mouseSubscriptionsRef.current.set(handler, current)
          rebuildOrderedMouseSubscriptions()
        }
        return
      }

      if (mouseSubscriptionsRef.current.size === 0) {
        enableMouseEvents()
      }

      const subscription: Subscription<MouseHandler> = {
        handler,
        priority: options?.priority ?? 0,
        order: nextOrderRef.current++,
      }
      mouseSubscriptionsRef.current.set(handler, subscription)
      rebuildOrderedMouseSubscriptions()
    },
    [rebuildOrderedMouseSubscriptions],
  )

  const unsubscribeMouse = useCallback(
    (handler: MouseHandler) => {
      const didDelete = mouseSubscriptionsRef.current.delete(handler)
      if (didDelete) {
        rebuildOrderedMouseSubscriptions()
        if (mouseSubscriptionsRef.current.size === 0) {
          disableMouseEvents()
        }
      }
    },
    [rebuildOrderedMouseSubscriptions],
  )

  const broadcast = useCallback((parsed: ParsedKey) => {
    const key = buildKey(parsed)
    const input = keyToInput(parsed)

    // Batch all updates triggered by key handlers into a single Ink render pass.
    // This matches Ink's `useInput` behavior and reduces intermediate-frame flicker.
    if (!batchedUpdates) {
      for (const subscription of orderedSubscriptionsRef.current) {
        const handled = subscription.handler(input, key)
        if (handled && typeof (handled as Promise<void>).catch === 'function') {
          ;(handled as Promise<void>).catch(error => {
            debugLogger.warn('KEYPRESS_HANDLER_PROMISE_REJECTED', {
              error: error instanceof Error ? error.message : String(error),
            })
          })
        }
        if (handled === true) {
          break
        }
      }
      return
    }

    batchedUpdates(() => {
      for (const subscription of orderedSubscriptionsRef.current) {
        const handled = subscription.handler(input, key)
        if (handled && typeof (handled as Promise<void>).catch === 'function') {
          ;(handled as Promise<void>).catch(error => {
            debugLogger.warn('KEYPRESS_HANDLER_PROMISE_REJECTED', {
              error: error instanceof Error ? error.message : String(error),
            })
          })
        }
        if (handled === true) {
          break
        }
      }
    })
  }, [])

  const broadcastMouse = useCallback((event: TerminalMouseEvent) => {
    if (!batchedUpdates) {
      for (const subscription of orderedMouseSubscriptionsRef.current) {
        const handled = subscription.handler(event)
        if (handled && typeof (handled as Promise<void>).catch === 'function') {
          ;(handled as Promise<void>).catch(error => {
            debugLogger.warn('MOUSE_HANDLER_PROMISE_REJECTED', {
              error: error instanceof Error ? error.message : String(error),
            })
          })
        }
        if (handled === true) break
      }
      return
    }

    batchedUpdates(() => {
      for (const subscription of orderedMouseSubscriptionsRef.current) {
        const handled = subscription.handler(event)
        if (handled && typeof (handled as Promise<void>).catch === 'function') {
          ;(handled as Promise<void>).catch(error => {
            debugLogger.warn('MOUSE_HANDLER_PROMISE_REJECTED', {
              error: error instanceof Error ? error.message : String(error),
            })
          })
        }
        if (handled === true) break
      }
    })
  }, [])

  useEffect(() => {
    const wasRaw = (stdin as unknown as { isRaw?: boolean } | null)?.isRaw
    const shouldEnableRaw =
      isRawModeSupported &&
      stdin.isTTY === true &&
      (wasRaw === false || wasRaw === undefined)
    if (shouldEnableRaw) {
      try {
        setRawMode(true)
      } catch (error) {
        debugLogger.warn('KEYPRESS_RAWMODE_ENABLE_FAILED', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    try {
      ;(
        stdin as unknown as { setEncoding?: (encoding: string) => void }
      ).setEncoding?.('utf8')
    } catch (error) {
      debugLogger.warn('KEYPRESS_SET_ENCODING_FAILED', {
        error: error instanceof Error ? error.message : String(error),
      })
    }

    let dataListener = createKeypressDataListener(
      broadcast,
      broadcastMouse,
      () => !terminalCapabilityManager.isBracketedPasteEnabled(),
    )

    if (debugKeystrokeLogging) {
      const old = dataListener
      dataListener = (data: string) => {
        if (data.length > 0) {
          debugLogger.ui('KEYPRESS_RAW', { data })
        }
        old(data)
      }
    }

    stdin.on('data', dataListener)
    return () => {
      stdin.removeListener('data', dataListener)
      if (shouldEnableRaw) {
        try {
          setRawMode(false)
        } catch {
          // best-effort only
        }
      }
    }
  }, [
    stdin,
    setRawMode,
    isRawModeSupported,
    debugKeystrokeLogging,
    broadcast,
    broadcastMouse,
  ])

  useEffect(() => {
    const mouseSubscriptions = mouseSubscriptionsRef
    const orderedMouseSubscriptions = orderedMouseSubscriptionsRef
    return () => {
      if (mouseSubscriptions.current.size > 0) {
        mouseSubscriptions.current.clear()
        orderedMouseSubscriptions.current = []
        disableMouseEvents()
      }
    }
  }, [])

  return (
    <KeypressContext.Provider
      value={{ subscribe, unsubscribe, subscribeMouse, unsubscribeMouse }}
    >
      {children}
    </KeypressContext.Provider>
  )
}
