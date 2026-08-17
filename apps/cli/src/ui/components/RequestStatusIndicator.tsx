import { Box, Text, useIsScreenReaderEnabled } from 'ink'
import React, { useEffect, useState } from 'react'
import { getTheme } from '#core/utils/theme'
import {
  formatRequestStatusDuration,
  getRequestStatus,
  getRequestStatusLabel,
  getRequestStatusPhaseLabel,
  getRequestStatusTiming,
  getRequestStatusTokenDisplay,
  REQUEST_STATUS_ESC_CANCEL_HINT,
  shouldShowRequestStatusPhase,
  subscribeRequestStatus,
  type RequestStatus,
} from '#core/utils/requestStatus'

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function __getRequestStatusLabelForTests(
  status: Parameters<typeof getRequestStatusLabel>[0],
  elapsedSeconds: number,
): string {
  return getRequestStatusLabel(status, elapsedSeconds)
}

export function RequestStatusIndicator({
  marginTop = 1,
}: {
  marginTop?: number
} = {}): React.ReactNode {
  const frames = SPINNER_FRAMES
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
      setFrame(f => (f + 1) % frames.length)
    }, 80)
    return () => clearInterval(timer)
  }, [frames.length, shouldAnimate])

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
    <Box flexDirection="row" marginTop={marginTop}>
      <Text color={theme.kode} bold>
        {frames[frame]}{' '}
        {__getRequestStatusLabelForTests(
          status,
          Math.floor(timing.requestDurationMs / 1000),
        )}
      </Text>
      <Text color={theme.secondaryText}>
        {shouldShowRequestStatusPhase(status, now)
          ? ` · ${getRequestStatusPhaseLabel(status, now)}`
          : ''}
        {' · total '}
        {formatRequestStatusDuration(
          Math.floor(timing.requestDurationMs / 1000),
        )}{' '}
        {REQUEST_STATUS_ESC_CANCEL_HINT}
        {getRequestStatusTokenDisplay(status)}
      </Text>
    </Box>
  )
}
