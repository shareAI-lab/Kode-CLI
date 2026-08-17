import { Box, Text } from 'ink'
import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { getTheme } from '#core/utils/theme'

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function SimpleSpinner(): React.ReactNode {
  const frames = SPINNER_FRAMES
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % frames.length)
    }, 80)

    return () => clearInterval(timer)
  }, [frames.length])

  return (
    <Box flexWrap="nowrap" height={1} width={2}>
      <Text color={getTheme().kode}>{frames[frame]}</Text>
    </Box>
  )
}

export function BashSpinner(): React.ReactNode {
  const frames = SPINNER_FRAMES
  const theme = getTheme()
  const [frame, setFrame] = useState(0)
  const [elapsedTime, setElapsedTime] = useState(0)
  const startTime = useRef(Date.now())

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % frames.length)
    }, 80)
    return () => clearInterval(timer)
  }, [frames.length])

  useEffect(() => {
    const timer = setInterval(() => {
      setElapsedTime(Math.floor((Date.now() - startTime.current) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  return (
    <Box flexDirection="row" marginTop={1}>
      <Text color={theme.kode} bold>
        {frames[frame]} Running
      </Text>
      <Text color={theme.secondaryText}>
        {' '}
        :: {elapsedTime}s (<Text bold>Esc</Text> cancel)
      </Text>
    </Box>
  )
}
