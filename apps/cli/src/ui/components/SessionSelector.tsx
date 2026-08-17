import React from 'react'
import { Box, Text } from 'ink'
import { getTheme } from '#core/utils/theme'
import { useTerminalSize } from '#ui-ink/hooks/useTerminalSize'
import { formatDate, logError } from '#core/utils/log'
import type { KodeAgentSessionListItem } from '#protocol/utils/kodeAgentSessionResume'
import figures from 'figures'
import { ScreenFrame } from '#ui-ink/primitives/layout/ScreenFrame'
import { useScreenLayout } from '#ui-ink/primitives/layout/useScreenLayout'
import { getWindowedList } from '#ui-ink/primitives/list/windowedList'
import { useKeypress } from '#ui-ink/hooks/useKeypress'
import { useExitOnCtrlCD } from '#ui-ink/hooks/useExitOnCtrlCD'
import { useCliExit } from '#ui-ink/hooks/useCliExit'
import { useScopedIndexState } from '#ui-ink/hooks/useScopedIndexState'

type SessionSelectorProps = {
  sessions: KodeAgentSessionListItem[]
  onSelect: (index: number) => void | Promise<void>
  onClose?: () => void
  escLabel?: string
  title?: string
  introText?: string
  enterLabel?: string
}

export function SessionSelector(props: SessionSelectorProps): React.ReactNode {
  if (props.sessions.length === 0) return null
  return <PopulatedSessionSelector {...props} />
}

function PopulatedSessionSelector({
  sessions,
  onSelect,
  onClose,
  escLabel = 'quit',
  title = 'Resume conversation',
  introText = 'Select a session to resume.',
  enterLabel = 'resume',
}: SessionSelectorProps): React.ReactNode {
  const theme = getTheme()
  const layout = useScreenLayout()
  const { rows } = useTerminalSize()

  const requestExit = useCliExit()
  const close = onClose ?? (() => requestExit(0))
  const exitState = useExitOnCtrlCD(() => requestExit(0))

  const [selectedIndex, setSelectedIndex] = useScopedIndexState({
    scope: `session-selector:${title}`,
    itemCount: sessions.length,
  })
  const didSubmitRef = React.useRef(false)
  const mountedRef = React.useRef(true)
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  const [submitError, setSubmitError] = React.useState<string | null>(null)

  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const reservedLines =
    (layout.tightLayout ? 7 : layout.compactLayout ? 9 : 11) +
    layout.paddingY * 2 +
    layout.gap * 3
  const maxVisible = Math.max(3, rows - reservedLines - 1)
  const window = React.useMemo(
    () =>
      getWindowedList({
        itemCount: sessions.length,
        focusIndex: selectedIndex,
        maxVisible,
        indicatorRows: 2,
      }),
    [maxVisible, selectedIndex, sessions.length],
  )

  const visibleSessions = React.useMemo(
    () => sessions.slice(window.start, window.end),
    [sessions, window.end, window.start],
  )

  useKeypress((input, key) => {
    if (didSubmitRef.current) return true

    const inputChar = input.length === 1 ? input : ''

    if (key.escape) {
      didSubmitRef.current = true
      close()
      return true
    }

    if (key.return) {
      didSubmitRef.current = true
      setIsSubmitting(true)
      setSubmitError(null)
      void Promise.resolve(onSelect(selectedIndex)).catch(error => {
        logError(error)
        if (!mountedRef.current) return
        didSubmitRef.current = false
        setIsSubmitting(false)
        setSubmitError(error instanceof Error ? error.message : String(error))
      })
      return true
    }

    if (exitState.pending) return true

    if (key.upArrow || inputChar === 'k') {
      setSelectedIndex(prev => Math.max(0, prev - 1))
      return true
    }

    if (key.downArrow || inputChar === 'j') {
      setSelectedIndex(prev => Math.min(sessions.length - 1, prev + 1))
      return true
    }

    if (key.pageUp) {
      setSelectedIndex(prev => Math.max(0, prev - window.visibleCount))
      return true
    }
    if (key.pageDown) {
      setSelectedIndex(prev =>
        Math.min(sessions.length - 1, prev + window.visibleCount),
      )
      return true
    }

    if (key.home || inputChar === 'g') {
      setSelectedIndex(0)
      return true
    }
    if (key.end || inputChar === 'G') {
      setSelectedIndex(Math.max(0, sessions.length - 1))
      return true
    }
    return undefined
  })

  const topIndicator = window.showUpIndicator ? `${figures.arrowUp} More` : ' '
  const bottomIndicator = window.showDownIndicator
    ? `${figures.arrowDown} More`
    : ' '

  const selectedSession = sessions[selectedIndex] ?? null
  const selectedTitle = selectedSession
    ? (selectedSession.customTitle ??
      selectedSession.slug ??
      selectedSession.sessionId)
    : null
  const selectedSummary = selectedSession?.summary
    ? selectedSession.summary.split('\n')[0]
    : null

  return (
    <ScreenFrame
      title={title}
      exitState={exitState}
      paddingX={layout.paddingX}
      paddingY={layout.paddingY}
      gap={layout.gap}
    >
      <Box flexDirection="column" gap={layout.gap}>
        <Text color={theme.secondaryText} wrap="truncate-end">
          {introText}
        </Text>

        <Box flexDirection="column" width="100%">
          <Text color={theme.secondaryText} wrap="truncate-end">
            {topIndicator}
          </Text>
          {visibleSessions.map((session, idx) => {
            const absoluteIndex = window.start + idx
            const isSelected = absoluteIndex === selectedIndex

            const modifiedAt =
              session.modifiedAt ?? session.createdAt ?? new Date(0)
            const modifiedLabel = formatDate(modifiedAt)
            const tag = session.tag ? `#${session.tag}` : ''
            const name =
              session.customTitle ?? session.slug ?? session.sessionId

            return (
              <Box key={absoluteIndex} flexDirection="row" gap={1}>
                <Text color={isSelected ? theme.kode : theme.secondaryText}>
                  {isSelected ? figures.pointer : ' '}
                </Text>
                <Text color={theme.secondaryText} wrap="truncate-end">
                  {modifiedLabel}
                </Text>
                {tag ? (
                  <Text color={theme.secondaryText} wrap="truncate-end">
                    {tag}
                  </Text>
                ) : null}
                <Text
                  bold={isSelected}
                  color={isSelected ? theme.text : theme.secondaryText}
                  wrap="truncate-end"
                >
                  {name}
                </Text>
              </Box>
            )
          })}
          <Text color={theme.secondaryText} wrap="truncate-end">
            {bottomIndicator}
          </Text>
        </Box>

        {selectedTitle ? (
          <Box paddingLeft={2} flexDirection="column">
            <Text color={theme.secondaryText} wrap="truncate-end">
              {selectedSummary ?? ''}
            </Text>
          </Box>
        ) : null}

        {submitError ? (
          <Text color={theme.error} wrap="truncate-end">
            {submitError}
          </Text>
        ) : null}

        {isSubmitting ? (
          <Text color={theme.secondaryText} wrap="truncate-end">
            {enterLabel === 'resume'
              ? 'Resuming conversation…'
              : 'Importing conversation…'}
          </Text>
        ) : null}

        <Text color={theme.secondaryText} wrap="truncate-end">
          ↑/↓ or j/k · PgUp/PgDn · Home/End · Enter {enterLabel} · Esc{' '}
          {escLabel}
        </Text>
      </Box>
    </ScreenFrame>
  )
}
