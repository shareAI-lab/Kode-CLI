import { Box, Text, useIsScreenReaderEnabled } from 'ink'
import React, { useEffect, useState } from 'react'
import type { ToolKeypressHandler } from '@kode/tool-interface/Tool'
import { getTheme } from '#core/utils/theme'
import {
  formatRequestStatusDuration,
  getRequestStatus,
  getRequestStatusLabel,
  getRequestStatusPhaseLabel,
  getRequestStatusTiming,
  getRequestStatusTokenDisplay,
  REQUEST_STATUS_ESC_CANCEL_HINT,
  subscribeRequestStatus,
  type RequestStatus,
} from '#core/utils/requestStatus'

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// NOTE: This component mirrors the main REPL RequestStatusIndicator shell so
// the Bash background overlay stays inside packages/tools (no dependency on
// the CLI app's UI layer). All wording/formatting comes from the shared
// #core/utils/requestStatus helpers, so the two views cannot drift apart.
function RequestStatusIndicator(): React.ReactNode {
  const theme = getTheme()
  const isScreenReaderEnabled = useIsScreenReaderEnabled()

  const [frame, setFrame] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [status, setStatus] = useState<RequestStatus>(() => getRequestStatus())

  const isVisible = status.kind !== 'idle'
  const shouldAnimate = isVisible && !isScreenReaderEnabled
  const timing = getRequestStatusTiming(status, now)

  useEffect(() => {
    return subscribeRequestStatus(next => {
      setStatus(next)
      setNow(Date.now())
    })
  }, [])

  useEffect(() => {
    if (!shouldAnimate) return undefined
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % SPINNER_FRAMES.length)
    }, 80)
    return () => clearInterval(timer)
  }, [shouldAnimate])

  useEffect(() => {
    if (!shouldAnimate) return undefined
    const timer = setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => clearInterval(timer)
  }, [shouldAnimate])

  if (!isVisible) {
    return null
  }

  return (
    <Box flexDirection="row" marginTop={1}>
      <Text color={theme.kode} bold>
        {SPINNER_FRAMES[frame]}{' '}
        {getRequestStatusLabel(
          status,
          Math.floor(timing.requestDurationMs / 1000),
        )}
      </Text>
      <Text color={theme.secondaryText}>
        {' '}
        · {getRequestStatusPhaseLabel(status, now)} · total{' '}
        {formatRequestStatusDuration(
          Math.floor(timing.requestDurationMs / 1000),
        )}{' '}
        {REQUEST_STATUS_ESC_CANCEL_HINT}
        {getRequestStatusTokenDisplay(status)}
      </Text>
    </Box>
  )
}

export function createRunInBackgroundKeypressHandler(
  onBackground: () => void,
): ToolKeypressHandler {
  let hasRequestedBackground = false

  return (input, key) => {
    if (input !== 'b' || !key.ctrl || key.meta || key.shift) return false
    if (!hasRequestedBackground) {
      hasRequestedBackground = true
      onBackground()
    }
    return true
  }
}

export function BashToolRunInBackgroundOverlay(): React.ReactNode {
  const shortcut = process.env.TMUX ? 'ctrl+b ctrl+b' : 'ctrl+b'

  return (
    <Box flexDirection="column">
      <RequestStatusIndicator />
      <Box paddingLeft={5}>
        <Text dimColor>{`${shortcut} run in background`}</Text>
      </Box>
    </Box>
  )
}
