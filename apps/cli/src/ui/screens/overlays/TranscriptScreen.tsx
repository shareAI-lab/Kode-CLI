import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Box, Text } from 'ink'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CACHE_PATHS, DATE } from '#core/logging/log/paths'
import { getTheme } from '#core/utils/theme'
import type { Message } from '#core/query'
import { getMessagesGetter } from '#core/messages'
import { launchExternalEditorForFilePath } from '#cli-utils/externalEditor'
import { copyTextToClipboard } from '#cli-utils/clipboard'
import { buildTranscriptLines } from '#cli-utils/transcriptText'
import { useKeypress } from '#ui-ink/hooks/useKeypress'
import { KEYPRESS_PRIORITY } from '#ui-ink/constants/keypressPriority'
import { ScreenFrame } from '#ui-ink/primitives/layout/ScreenFrame'
import { useScreenLayout } from '#ui-ink/primitives/layout/useScreenLayout'
import {
  computeAvailableRows,
  computeScreenFrameReservedRows,
} from '#ui-ink/primitives/layout/viewportRows'
import { wrapLines } from '#ui-ink/primitives/text/wrapLines'

const VIEWPORT_SAFE_MARGIN_ROWS = 1
const INDICATOR_ROWS = 2
const REFRESH_INTERVAL_MS = 250
const MAX_TOOL_BLOCK_CHARS_COLLAPSED = 4000

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function getTranscriptPath(label?: string): string {
  const suffix = label ? `-${label.replace(/[^a-zA-Z0-9._-]+/g, '-')}` : ''
  return join(CACHE_PATHS.errors(), `transcript${suffix}-${DATE}.txt`)
}

export function TranscriptScreen({
  onDone,
  label,
  initialFollow = false,
}: {
  onDone: (result?: string) => void
  label?: string
  initialFollow?: boolean
}): React.ReactNode {
  const theme = getTheme()
  const layout = useScreenLayout()
  const exitState = { pending: false, keyName: null as null } as const

  const [follow, setFollow] = useState(initialFollow)
  const [scrollTop, setScrollTop] = useState(0)
  const [status, setStatus] = useState<string | null>(null)
  const [savedPath, setSavedPath] = useState<string | null>(null)
  const [verbose, setVerbose] = useState(false)
  const isOpeningRef = useRef(false)
  const isCopyingRef = useRef(false)
  const mountedRef = useRef(true)

  const lastMessagesRef = useRef<Message[] | null>(null)
  const [messagesSnapshot, setMessagesSnapshot] = useState<Message[]>(() =>
    getMessagesGetter()(),
  )

  const refreshSnapshot = useCallback(() => {
    const next = getMessagesGetter()()
    if (lastMessagesRef.current === next) return
    lastMessagesRef.current = next
    setMessagesSnapshot(next)
  }, [])

  useEffect(() => {
    if (!follow) return undefined
    refreshSnapshot()
    const interval = setInterval(() => refreshSnapshot(), REFRESH_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [follow, refreshSnapshot])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      isOpeningRef.current = false
      isCopyingRef.current = false
    }
  }, [])

  const rawLines = useMemo(
    () =>
      buildTranscriptLines(messagesSnapshot, {
        includeTools: true,
        collapseToolBlocks: !verbose,
        maxCollapsedChars: MAX_TOOL_BLOCK_CHARS_COLLAPSED,
      }),
    [messagesSnapshot, verbose],
  )
  const wrappedLines = useMemo(() => {
    const width = Math.max(1, layout.columns - layout.paddingX * 2)
    return wrapLines(rawLines, width)
  }, [layout.columns, layout.paddingX, rawLines])

  const frameRows = computeScreenFrameReservedRows({
    paddingY: layout.paddingY,
    gap: layout.gap,
    exitPromptRows: exitState.pending ? 1 : 0,
  })
  const innerReservedRows =
    1 + // saved path
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
  const maxScrollTop = Math.max(0, wrappedLines.length - contentRows)

  const didInitScrollRef = useRef(false)
  useLayoutEffect(() => {
    if (didInitScrollRef.current) return
    didInitScrollRef.current = true
    setScrollTop(maxScrollTop)
  }, [maxScrollTop])

  useEffect(() => {
    setScrollTop(prev => {
      if (follow) return maxScrollTop
      return clamp(prev, 0, maxScrollTop)
    })
  }, [contentRows, follow, maxScrollTop])

  const save = useCallback(() => {
    try {
      const path = getTranscriptPath(label)
      mkdirSync(CACHE_PATHS.errors(), { recursive: true })
      writeFileSync(path, rawLines.join('\n') + '\n', 'utf8')
      setSavedPath(path)
      setStatus(`Saved to ${path}`)
      return path
    } catch {
      setStatus('Failed to save transcript')
      return null
    }
  }, [label, rawLines])

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

  const copyTranscript = useCallback(async () => {
    if (isCopyingRef.current) return

    isCopyingRef.current = true
    setStatus('Copying transcript to clipboard…')

    try {
      const result = await copyTextToClipboard(rawLines.join('\n') + '\n')
      if (!mountedRef.current) return

      if (result.method === 'osc52' && result.truncated) {
        setStatus('Copied transcript (OSC 52, truncated)')
      } else {
        setStatus('Copied transcript to clipboard')
      }
    } catch (error) {
      if (!mountedRef.current) return

      const message = error instanceof Error ? error.message : String(error)
      setStatus(`Copy failed: ${message}`)
    } finally {
      isCopyingRef.current = false
    }
  }, [rawLines])

  useKeypress(
    (input, key) => {
      if (key.escape || (key.ctrl && input === 'c')) {
        onDone()
        return true
      }

      if (key.ctrl && input === 'o') {
        onDone()
        return true
      }

      if (key.ctrl && input === 'e') {
        setVerbose(prev => {
          const next = !prev
          setStatus(`Verbose: ${next ? 'ON' : 'OFF'}`)
          return next
        })
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

      if (key.home || input === 'g') {
        setFollow(false)
        setScrollTop(0)
        return true
      }

      if (key.end || input === 'G') {
        setFollow(true)
        setScrollTop(maxScrollTop)
        return true
      }

      if (input === 'r') {
        refreshSnapshot()
        setStatus('Refreshed')
        return true
      }

      if (input === 'f') {
        setFollow(prev => {
          const next = !prev
          setStatus(`Follow: ${next ? 'ON' : 'OFF'}`)
          return next
        })
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

      if (input === 'y') {
        void copyTranscript()
        return true
      }

      return undefined
    },
    { priority: KEYPRESS_PRIORITY.FULLSCREEN_OVERLAY },
  )

  const hiddenAbove = scrollTop
  const hiddenBelow = Math.max(
    0,
    wrappedLines.length - (scrollTop + contentRows),
  )
  const visibleLines = useMemo(() => {
    return wrappedLines.slice(scrollTop, scrollTop + contentRows)
  }, [contentRows, scrollTop, wrappedLines])

  const topIndicator = hiddenAbove ? `... ${hiddenAbove} lines hidden ...` : ''
  const bottomIndicator = hiddenBelow
    ? `... ${hiddenBelow} lines hidden ...`
    : ''

  const statusLine =
    status ??
    (wrappedLines.length > 0
      ? `Showing ${Math.min(contentRows, wrappedLines.length)} of ${wrappedLines.length} lines`
      : 'Empty transcript')

  const logPath = getTranscriptPath(label)

  return (
    <ScreenFrame
      title="Transcript"
      exitState={exitState}
      paddingX={layout.paddingX}
      paddingY={layout.paddingY}
      gap={layout.gap}
    >
      <Box flexDirection="column">
        <Text dimColor wrap="truncate-end">
          Saved path: {logPath}
        </Text>

        <Text dimColor wrap="truncate-end">
          {follow ? 'Follow: ON' : 'Follow: OFF'} · Scroll: ↑↓ j/k PgUp/PgDn
          Home/End · f follow · r refresh · y copy · s save · o open · ctrl+o
          close · ctrl+e show all · Esc close
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
              color={
                line.startsWith('user:')
                  ? theme.secondaryText
                  : line.startsWith('assistant:')
                    ? theme.text
                    : line.includes('[tool_result') ||
                        line.includes('[tool_use')
                      ? theme.warning
                      : theme.text
              }
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
