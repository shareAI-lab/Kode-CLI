import React from 'react'
import { Box, Text } from 'ink'

import { DEFAULT_CONTEXT_LENGTH, type ContextLengthOption } from '../options'
import {
  ScreenFrame,
  type ScreenExitState,
} from '#ui-ink/primitives/layout/ScreenFrame'

type Props = {
  theme: any
  exitState: ScreenExitState
  compactLayout: boolean
  tightLayout: boolean
  containerPaddingY: number
  containerGap: number
  contextLength: number
  contextLengthOptions: ContextLengthOption[]
}

export function ContextLengthScreen({
  theme,
  exitState,
  compactLayout,
  tightLayout,
  containerPaddingY,
  containerGap,
  contextLength,
  contextLengthOptions,
}: Props) {
  const selectedOption =
    contextLengthOptions.find(opt => opt.value === contextLength) ||
    contextLengthOptions.find(opt => opt.value === DEFAULT_CONTEXT_LENGTH) ||
    contextLengthOptions[0]!

  return (
    <ScreenFrame
      title="Advanced context window / 高级上下文"
      exitState={exitState}
      paddingX={tightLayout || compactLayout ? 1 : 2}
      paddingY={containerPaddingY}
      gap={containerGap}
    >
      <Box flexDirection="column" gap={containerGap}>
        <Text bold>Set the configured context window:</Text>
        {!tightLayout && (
          <Text color={theme.secondaryText}>
            {compactLayout
              ? 'Used for local context management; it does not change provider limits.'
              : 'Use only a verified provider limit. This value guides Kode context management; it cannot increase model capacity or estimate cost without provider pricing data.'}
          </Text>
        )}

        <Box flexDirection="column" marginY={tightLayout ? 0 : 1}>
          {contextLengthOptions.map(option => {
            const isSelected = option.value === contextLength
            return (
              <Box key={option.value} flexDirection="row">
                <Text color={isSelected ? theme.suggestion : undefined}>
                  {isSelected ? '→ ' : '  '}
                  {option.label}
                  {option.value === DEFAULT_CONTEXT_LENGTH
                    ? ' (recommended)'
                    : ''}
                </Text>
              </Box>
            )
          })}
        </Box>

        {!tightLayout && (
          <Text dimColor>
            Selected:{' '}
            <Text color={theme.suggestion}>{selectedOption.label}</Text>
          </Text>
        )}

        <Box marginTop={tightLayout ? 0 : 1}>
          <Text color={theme.secondaryText}>
            ↑/↓ select · Enter continue · Esc back
          </Text>
        </Box>
      </Box>
    </ScreenFrame>
  )
}
