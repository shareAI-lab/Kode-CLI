import React from 'react'
import {
  normalizeLineEndings,
  shouldTreatAsSpecialPaste,
} from '#core/utils/paste'

const BRACKETED_PASTE_START = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'
// Some input decoders (including Ink in certain terminals) may strip the leading ESC and
// deliver the CSI sequences as "[200~" / "[201~". Accept both forms to avoid leaking markers into input.
const BRACKETED_PASTE_START_NO_ESC = '[200~'
const BRACKETED_PASTE_END_NO_ESC = '[201~'

type BracketedPasteState = {
  mode: 'normal' | 'in_paste'
  incomplete: string
  buffer: string
}

function longestSuffixPrefix(haystack: string, needle: string): number {
  const max = Math.min(haystack.length, needle.length - 1)
  for (let len = max; len > 0; len--) {
    if (haystack.endsWith(needle.slice(0, len))) return len
  }
  return 0
}

function findFirstMarker(
  haystack: string,
  markers: string[],
): { index: number; marker: string } | null {
  let best: { index: number; marker: string } | null = null
  for (const marker of markers) {
    const index = haystack.indexOf(marker)
    if (index === -1) continue
    if (!best || index < best.index) {
      best = { index, marker }
    }
  }
  return best
}

function getSuffixKeepLength(haystack: string, markers: string[]): number {
  let keep = 0
  for (const marker of markers) {
    keep = Math.max(keep, longestSuffixPrefix(haystack, marker))
  }
  return keep
}

export type BracketedPasteHandlerOptions = {
  insertText: (text: string) => void
  onPaste?: (text: string) => void
  terminalColumns?: number
}

export function useBracketedPasteSequences({
  insertText,
  onPaste,
  terminalColumns,
}: BracketedPasteHandlerOptions): (input: string) => boolean {
  const stateRef = React.useRef<BracketedPasteState>({
    mode: 'normal',
    incomplete: '',
    buffer: '',
  })
  const mountedRef = React.useRef(true)
  const deferredPasteTimersRef = React.useRef(
    new Set<ReturnType<typeof setTimeout>>(),
  )

  React.useEffect(() => {
    const deferredPasteTimers = deferredPasteTimersRef.current
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      for (const timer of deferredPasteTimers) {
        clearTimeout(timer)
      }
      deferredPasteTimers.clear()
    }
  }, [])

  const schedulePasteCallback = React.useCallback(
    (text: string) => {
      const timer = setTimeout(() => {
        deferredPasteTimersRef.current.delete(timer)
        if (mountedRef.current) onPaste?.(text)
      }, 0)
      deferredPasteTimersRef.current.add(timer)
    },
    [onPaste],
  )

  const flushBracketedPasteBuffer = React.useCallback(
    (rawText: string) => {
      const normalized = normalizeLineEndings(rawText)
      if (
        onPaste &&
        shouldTreatAsSpecialPaste(normalized, { terminalColumns })
      ) {
        // Schedule callback outside the keypress frame so large paste handling
        // doesn't block cursor updates.
        schedulePasteCallback(normalized)
        return
      }

      // Normal paste: insert directly into input.
      insertText(normalized)
    },
    [insertText, onPaste, schedulePasteCallback, terminalColumns],
  )

  return React.useCallback(
    (input: string): boolean => {
      const state = stateRef.current
      let handledAny = false
      let data = state.incomplete + input
      state.incomplete = ''

      const startMarkers = [BRACKETED_PASTE_START, BRACKETED_PASTE_START_NO_ESC]
      const endMarkers = [BRACKETED_PASTE_END, BRACKETED_PASTE_END_NO_ESC]

      while (data) {
        if (state.mode === 'normal') {
          const start = findFirstMarker(data, startMarkers)
          if (!start) {
            const keep = getSuffixKeepLength(data, startMarkers)
            if (keep === 0) {
              if (!handledAny) {
                return false
              }
              insertText(data)
              return true
            }

            const toInsert = data.slice(0, -keep)
            if (toInsert) {
              insertText(toInsert)
            }
            state.incomplete = data.slice(-keep)
            handledAny = true
            return true
          }

          const before = data.slice(0, start.index)
          if (before) {
            insertText(before)
          }

          data = data.slice(start.index + start.marker.length)
          state.mode = 'in_paste'
          handledAny = true
          continue
        }

        const end = findFirstMarker(data, endMarkers)
        if (!end) {
          const keep = getSuffixKeepLength(data, endMarkers)
          const content = keep > 0 ? data.slice(0, -keep) : data
          if (content) {
            state.buffer += content
          }
          if (keep > 0) {
            state.incomplete = data.slice(-keep)
          }
          handledAny = true
          return true
        }

        state.buffer += data.slice(0, end.index)
        const completedPaste = state.buffer
        state.buffer = ''
        state.mode = 'normal'

        flushBracketedPasteBuffer(completedPaste)

        data = data.slice(end.index + end.marker.length)
        handledAny = true
        continue
      }

      return true
    },
    [flushBracketedPasteBuffer, insertText],
  )
}
