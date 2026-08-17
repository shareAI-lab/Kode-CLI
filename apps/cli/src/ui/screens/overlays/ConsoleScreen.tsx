import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text } from 'ink'
import { getTheme } from '#core/utils/theme'
import {
  clearCapturedTuiStdio,
  flushCapturedTuiStdioToFile,
  getCapturedTuiStdioLogPath,
  getCapturedTuiStdioText,
} from '#cli-utils/stdio'
import { launchExternalEditorForFilePath } from '#cli-utils/externalEditor'
import { useKeypress } from '#ui-ink/hooks/useKeypress'
import { KEYPRESS_PRIORITY } from '#ui-ink/constants/keypressPriority'
import { ScreenFrame } from '#ui-ink/primitives/layout/ScreenFrame'
import { useScreenLayout } from '#ui-ink/primitives/layout/useScreenLayout'
import {
  computeAvailableRows,
  computeScreenFrameReservedRows,
} from '#ui-ink/primitives/layout/viewportRows'

const VIEWPORT_SAFE_MARGIN_ROWS = 1
const INDICATOR_ROWS = 2

function escapeControlCharactersForDisplay(text: string): string {
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0)
    if (code === undefined) continue
    if (char === '\n') {
      out += '\n'
      continue
    }
    if (char === '\t') {
      out += '\t'
      continue
    }
    if (char === '\r') {
      out += '\\r'
      continue
    }
    if (code === 0x1b) {
      out += '\\x1b'
      continue
    }
    if (code < 0x20 || code === 0x7f) {
      out += `\\x${code.toString(16).padStart(2, '0')}`
      continue
    }
    out += char
  }
  return out
}

function loadCapturedLines(): string[] {
  const captured = getCapturedTuiStdioText()
  if (!captured) return []
  const safe = escapeControlCharactersForDisplay(captured)
  return safe.split('\n')
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function ConsoleScreen({
  onDone,
}: {
  onDone: (result?: string) => void
}): React.ReactNode {
  const theme = getTheme()
  const layout = useScreenLayout()
  const exitState = { pending: false, keyName: null as null } as const

  const [lines, setLines] = useState<string[]>(() => loadCapturedLines())
  const [follow, setFollow] = useState(true)
  const [scrollTop, setScrollTop] = useState(0)
  const [status, setStatus] = useState<string | null>(null)
  const [savedPath, setSavedPath] = useState<string | null>(null)
  const isOpeningRef = useRef(false)
  const mountedRef = useRef(true)

  const frameRows = computeScreenFrameReservedRows({
    paddingY: layout.paddingY,
    gap: layout.gap,
    exitPromptRows: exitState.pending ? 1 : 0,
  })
  const innerReservedRows =
    1 + // description
    1 + // shortcut line
    1 + // status line
    INDICATOR_ROWS +
    1 // tip line

  const contentRows = computeAvailableRows({
    rows: layout.rows,
    reservedRows: frameRows + innerReservedRows,
    safeMarginRows: VIEWPORT_SAFE_MARGIN_ROWS,
    minRows: 1,
  })

  const maxScrollTop = Math.max(0, lines.length - contentRows)

  useEffect(() => {
    setScrollTop(prev => {
      if (follow) return maxScrollTop
      return clamp(prev, 0, maxScrollTop)
    })
  }, [contentRows, follow, maxScrollTop])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      isOpeningRef.current = false
    }
  }, [])

  const refresh = useCallback(() => {
    setLines(loadCapturedLines())
    setStatus('Refreshed')
  }, [])

  const clear = useCallback(() => {
    clearCapturedTuiStdio()
    setLines([])
    setSavedPath(null)
    setScrollTop(0)
    setFollow(true)
    setStatus('Cleared captured output')
  }, [])

  const save = useCallback(() => {
    const path = flushCapturedTuiStdioToFile()
    if (!path) {
      setStatus('No captured output to save')
      return null
    }
    setSavedPath(path)
    setStatus(`Saved to ${path}`)
    return path
  }, [])

  const openSaved = useCallback(async () => {
    if (isOpeningRef.current) return
    const path = savedPath ?? save()
    if (!path) return

    isOpeningRef.current = true
    setStatus('Opening external editor…')

    try {
      const result = await launchExternalEditorForFilePath(path)
      if (!mountedRef.current) return

      if (result.ok === true) {
        setStatus(`Opened in ${result.editorLabel}`)
      } else {
        setStatus(result.error.message || 'Failed to open file')
      }
    } catch {
      if (mountedRef.current) {
        setStatus(
          'Unable to open the external editor. Check $EDITOR and try again.',
        )
      }
    } finally {
      isOpeningRef.current = false
    }
  }, [save, savedPath])

  useKeypress(
    (input, key) => {
      if (key.escape || (key.ctrl && input === 'c')) {
        onDone()
        return true
      }

      if (key.upArrow) {
        setFollow(false)
        setScrollTop(prev => clamp(prev - 1, 0, maxScrollTop))
        return true
      }

      if (key.downArrow) {
        setScrollTop(prev => {
          const next = clamp(prev + 1, 0, maxScrollTop)
          if (next >= maxScrollTop) setFollow(true)
          return next
        })
        return true
      }

      if (key.pageUp) {
        setFollow(false)
        setScrollTop(prev => clamp(prev - contentRows, 0, maxScrollTop))
        return true
      }

      if (key.pageDown) {
        setScrollTop(prev => {
          const next = clamp(prev + contentRows, 0, maxScrollTop)
          if (next >= maxScrollTop) setFollow(true)
          return next
        })
        return true
      }

      if (key.home) {
        setFollow(false)
        setScrollTop(0)
        return true
      }

      if (key.end) {
        setFollow(true)
        setScrollTop(maxScrollTop)
        return true
      }

      // j/k scrolling, matching the footer and the Help/Status screens.
      if (input === 'j') {
        setFollow(false)
        setScrollTop(prev => clamp(prev - 1, 0, maxScrollTop))
        return true
      }

      if (input === 'k') {
        setScrollTop(prev => {
          const next = clamp(prev + 1, 0, maxScrollTop)
          if (next >= maxScrollTop) setFollow(true)
          return next
        })
        return true
      }

      if (input === 'r') {
        refresh()
        return true
      }

      if (input === 'c') {
        clear()
        return true
      }

      if (input === 's') {
        save()
        return true
      }

      if (input === 'o') {
        void openSaved()
        return true
      }

      return undefined
    },
    { priority: KEYPRESS_PRIORITY.FULLSCREEN_OVERLAY },
  )

  const hiddenAbove = scrollTop
  const hiddenBelow = Math.max(0, lines.length - (scrollTop + contentRows))

  const visibleLines = useMemo(() => {
    return lines.slice(scrollTop, scrollTop + contentRows)
  }, [contentRows, lines, scrollTop])

  const topIndicator = hiddenAbove ? `... ${hiddenAbove} lines hidden ...` : ''
  const bottomIndicator = hiddenBelow
    ? `... ${hiddenBelow} lines hidden ...`
    : ''

  const statusLine =
    status ??
    (lines.length > 0
      ? `Showing ${Math.min(contentRows, lines.length)} of ${lines.length} lines`
      : 'No captured output')

  const logPath = getCapturedTuiStdioLogPath()

  return (
    <ScreenFrame
      title="Console"
      exitState={exitState}
      paddingX={layout.paddingX}
      paddingY={layout.paddingY}
      gap={layout.gap}
    >
      <Box flexDirection="column">
        <Text dimColor wrap="truncate-end">
          Captured TUI stdout/stderr (auto-flush path: {logPath})
        </Text>

        <Text dimColor wrap="truncate-end">
          {follow ? 'Follow: ON' : 'Follow: OFF'} · Scroll: ↑↓ j/k PgUp/PgDn
          Home/End · r refresh · s save · o open · c clear · Esc close
        </Text>

        <Text color={theme.secondaryText} wrap="truncate-end">
          {statusLine}
        </Text>

        <Text dimColor wrap="truncate-end">
          {topIndicator}
        </Text>
        {visibleLines.length > 0 ? (
          visibleLines.map((line, idx) => (
            <Text
              key={`${scrollTop}:${idx}`}
              color={line.startsWith('[stderr]') ? theme.error : theme.text}
              wrap="truncate-end"
            >
              {line}
            </Text>
          ))
        ) : (
          <Text dimColor>(empty)</Text>
        )}
        <Text dimColor wrap="truncate-end">
          {bottomIndicator}
        </Text>

        <Text dimColor wrap="truncate-end">
          {savedPath
            ? `Saved: ${savedPath}`
            : `Tip: use 's' to save and 'o' to open`}
        </Text>
      </Box>
    </ScreenFrame>
  )
}
