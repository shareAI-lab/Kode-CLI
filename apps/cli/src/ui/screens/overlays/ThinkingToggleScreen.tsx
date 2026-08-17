import React, { useCallback, useState } from 'react'
import { Box, Text } from 'ink'
import figures from 'figures'

import { getTheme } from '#core/utils/theme'
import { useKeypress } from '#ui-ink/hooks/useKeypress'
import { KEYPRESS_PRIORITY } from '#ui-ink/constants/keypressPriority'
import { ScreenFrame } from '#ui-ink/primitives/layout/ScreenFrame'
import { useScreenLayout } from '#ui-ink/primitives/layout/useScreenLayout'
import { PressableRow } from '#ui-ink/primitives/list/PressableRow'

export type ThinkingMode = 'auto' | 'enabled' | 'disabled'

export type ThinkingModeOption = {
  value: ThinkingMode
  label: string
  description: string
}

export const THINKING_MODE_OPTIONS: readonly ThinkingModeOption[] = [
  {
    value: 'auto',
    label: 'Automatic',
    description:
      'Use the model profile; “ultrathink” enables it when supported',
  },
  {
    value: 'enabled',
    label: 'Enabled',
    description: 'Request extended thinking from providers that support it',
  },
  {
    value: 'disabled',
    label: 'Disabled',
    description: 'Do not request or display provider reasoning summaries',
  },
]

export function getThinkingModeLabel(mode: ThinkingMode): string {
  switch (mode) {
    case 'enabled':
      return 'ON'
    case 'disabled':
      return 'OFF'
    default:
      return 'AUTO'
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function ThinkingToggleScreen({
  currentMode,
  isMidConversation,
  onSelect,
  onDone,
}: {
  currentMode: ThinkingMode
  isMidConversation: boolean
  onSelect: (value: ThinkingMode) => void
  onDone: () => void
}): React.ReactNode {
  const theme = getTheme()
  const layout = useScreenLayout()
  const exitState = { pending: false, keyName: null as null } as const

  const initialIndex = Math.max(
    0,
    THINKING_MODE_OPTIONS.findIndex(option => option.value === currentMode),
  )
  // This is a confirmation menu, rather than a navigation list. Retaining an
  // unconfirmed cursor from a prior invocation makes the highlighted row diverge
  // from the active session mode, so deliberately keep its state local.
  const [selectedIndex, setSelectedIndex] = useState(initialIndex)

  const selectOption = useCallback(
    (index: number) => {
      const option = THINKING_MODE_OPTIONS[index]
      if (!option) return false
      setSelectedIndex(index)
      onSelect(option.value)
      onDone()
      return true
    },
    [onDone, onSelect],
  )

  const confirm = useCallback(() => {
    selectOption(selectedIndex)
  }, [selectedIndex, selectOption])

  useKeypress(
    (input, key) => {
      const inputChar = input.length === 1 ? input : ''

      if (
        key.escape ||
        (key.ctrl && inputChar === 'c') ||
        (key.meta && inputChar === 't')
      ) {
        onDone()
        return true
      }

      if (key.return) {
        confirm()
        return true
      }

      if (key.upArrow || inputChar === 'k') {
        setSelectedIndex(prev =>
          clamp(prev - 1, 0, Math.max(0, THINKING_MODE_OPTIONS.length - 1)),
        )
        return true
      }

      if (key.downArrow || inputChar === 'j') {
        setSelectedIndex(prev =>
          clamp(prev + 1, 0, Math.max(0, THINKING_MODE_OPTIONS.length - 1)),
        )
        return true
      }

      return undefined
    },
    { priority: KEYPRESS_PRIORITY.FULLSCREEN_OVERLAY },
  )

  const shortcutLine = '↑/↓ select · Enter confirm · Esc/Ctrl+C close'

  return (
    <ScreenFrame
      title="Toggle thinking mode"
      exitState={exitState}
      paddingX={layout.paddingX}
      paddingY={layout.paddingY}
      gap={layout.gap}
    >
      <Box flexDirection="column" gap={layout.gap}>
        <Text dimColor wrap="truncate-end">
          {shortcutLine}
        </Text>

        <Box flexDirection="column">
          <Text dimColor wrap="truncate-end">
            This applies to new requests in this session. Model capability and
            policy determine how the request is honored.
          </Text>
          {isMidConversation && (
            <Text color={theme.warning}>
              Existing messages are unchanged. Set this before a new request for
              predictable results.
            </Text>
          )}
        </Box>

        <Box flexDirection="column">
          {THINKING_MODE_OPTIONS.map((option, idx) => {
            const isSelected = idx === selectedIndex
            return (
              <PressableRow
                key={option.label}
                onPress={() => selectOption(idx)}
              >
                <Text
                  color={isSelected ? theme.text : theme.secondaryText}
                  bold={isSelected}
                  wrap="truncate-end"
                >
                  {isSelected ? figures.pointer : ' '} {option.label} —{' '}
                  {option.description}
                </Text>
              </PressableRow>
            )
          })}
        </Box>
      </Box>
    </ScreenFrame>
  )
}
