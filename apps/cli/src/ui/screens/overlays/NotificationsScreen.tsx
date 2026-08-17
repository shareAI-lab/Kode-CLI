import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text } from 'ink'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CACHE_PATHS, DATE } from '#core/logging/log/paths'
import { getTheme } from '#core/utils/theme'
import {
  clearNotifications,
  getNotifications,
  subscribeNotifications,
  type InAppNotification,
} from '#core/services/notificationCenter'
import { launchExternalEditorForFilePath } from '#cli-utils/externalEditor'
import { useKeypress } from '#ui-ink/hooks/useKeypress'
import { KEYPRESS_PRIORITY } from '#ui-ink/constants/keypressPriority'
import { ScreenFrame } from '#ui-ink/primitives/layout/ScreenFrame'
import { useScreenLayout } from '#ui-ink/primitives/layout/useScreenLayout'

const VIEWPORT_SAFE_MARGIN_ROWS = 1
const INDICATOR_ROWS = 2

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function getLogPath(): string {
  return join(CACHE_PATHS.errors(), `notifications-${DATE}.log`)
}

function sanitizeSingleLine(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
}

function formatNotificationLine(n: InAppNotification): string {
  const time = new Date(n.createdAt).toLocaleTimeString()
  const source = n.source ?? 'system'
  const channel = n.channel ? `/${n.channel}` : ''
  const titlePrefix = n.title ? `${sanitizeSingleLine(n.title)}: ` : ''
  const message = sanitizeSingleLine(n.message)
  const kind = n.kind ? ` ${n.kind.toUpperCase()}` : ''
  return `[${time}] [${source}${channel}${kind}] ${titlePrefix}${message}`
}

function flushNotificationsToFile(notifs: InAppNotification[]): string | null {
  if (notifs.length === 0) return null
  try {
    const dir = CACHE_PATHS.errors()
    mkdirSync(dir, { recursive: true })
    const path = getLogPath()
    const content = notifs.map(formatNotificationLine).join('\n') + '\n'
    writeFileSync(path, content, 'utf8')
    return path
  } catch {
    return null
  }
}

export function NotificationsScreen({
  onDone,
}: {
  onDone: (result?: string) => void
}): React.ReactNode {
  const theme = getTheme()
  const layout = useScreenLayout()
  const exitState = { pending: false, keyName: null as null } as const
  const didDoneRef = useRef(false)

  const safeOnDone = useCallback(
    (result?: string) => {
      if (didDoneRef.current) return
      didDoneRef.current = true
      onDone(result)
    },
    [onDone],
  )

  const [notifs, setNotifs] = useState<InAppNotification[]>(() =>
    getNotifications(),
  )
  const [follow, setFollow] = useState(true)
  const [scrollTop, setScrollTop] = useState(0)
  const [status, setStatus] = useState<string | null>(null)
  const [savedPath, setSavedPath] = useState<string | null>(null)
  const isOpeningRef = useRef(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    return subscribeNotifications(() => {
      setNotifs(getNotifications())
    })
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      isOpeningRef.current = false
    }
  }, [])

  const lines = useMemo(() => notifs.map(formatNotificationLine), [notifs])

  const frameHeaderRows = 1
  const frameRows = frameHeaderRows + 1 + layout.gap * 2 + layout.paddingY * 2
  const innerReservedRows =
    1 + // description
    1 + // shortcut line
    1 + // status line
    INDICATOR_ROWS +
    1 // tip line

  const contentRows = Math.max(
    1,
    layout.rows - frameRows - innerReservedRows - VIEWPORT_SAFE_MARGIN_ROWS,
  )
  const maxScrollTop = Math.max(0, lines.length - contentRows)

  useEffect(() => {
    setScrollTop(prev => {
      if (follow) return maxScrollTop
      return clamp(prev, 0, maxScrollTop)
    })
  }, [contentRows, follow, maxScrollTop])

  const refresh = useCallback(() => {
    setNotifs(getNotifications())
    setStatus('Refreshed')
  }, [])

  const clear = useCallback(() => {
    clearNotifications()
    setSavedPath(null)
    setScrollTop(0)
    setFollow(true)
    setStatus('Cleared notifications')
  }, [])

  const save = useCallback(() => {
    const path = flushNotificationsToFile(getNotifications())
    if (!path) {
      setStatus('No notifications to save')
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
        safeOnDone()
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

  const topIndicator = hiddenAbove ? `... ${hiddenAbove} hidden ...` : ''
  const bottomIndicator = hiddenBelow ? `... ${hiddenBelow} hidden ...` : ''

  const statusLine =
    status ??
    (lines.length > 0
      ? `Showing ${Math.min(contentRows, lines.length)} of ${lines.length}`
      : 'No notifications')

  const logPath = getLogPath()

  return (
    <ScreenFrame
      title="Notifications"
      exitState={exitState}
      paddingX={layout.paddingX}
      paddingY={layout.paddingY}
      gap={layout.gap}
    >
      <Box flexDirection="column">
        <Text dimColor wrap="truncate-end">
          In-app notification history (auto-flush path: {logPath})
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
              color={line.includes(' ERROR]') ? theme.error : theme.text}
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
