import React from 'react'
import { Box, Text } from 'ink'

import { CONTEXT_LENGTH_OPTIONS } from '../options'
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
  selectedProvider: string
  selectedModel: string
  resourceName: string
  ollamaBaseUrl: string
  customBaseUrl: string
  maxTokens: string
  contextLength: number
  supportsReasoningEffort: boolean
  reasoningEffort: any
  validationError: string | null
  getProviderLabel: (provider: string, modelCount: number) => string
}

export function ConfirmationScreen({
  theme,
  exitState,
  compactLayout,
  tightLayout,
  containerPaddingY,
  containerGap,
  selectedProvider,
  selectedModel,
  resourceName,
  ollamaBaseUrl,
  customBaseUrl,
  maxTokens,
  contextLength,
  supportsReasoningEffort,
  reasoningEffort,
  validationError,
  getProviderLabel,
}: Props) {
  // Show model profile being created

  // Get provider display name
  const providerDisplayName = getProviderLabel(selectedProvider, 0).split(
    ' (',
  )[0]

  return (
    <ScreenFrame
      title="Configuration Confirmation"
      exitState={exitState}
      paddingX={tightLayout || compactLayout ? 1 : 2}
      paddingY={containerPaddingY}
      gap={containerGap}
    >
      <Box flexDirection="column" gap={containerGap}>
        <Text bold>Confirm your model configuration:</Text>
        {!tightLayout && (
          <Text color={theme.secondaryText}>
            Please review your selections before saving.
          </Text>
        )}

        {validationError && (
          <Box flexDirection="column" marginTop={tightLayout ? 0 : 1}>
            <Text color={theme.error} bold>
              ⚠ Configuration Error:
            </Text>
            <Text color={theme.error}>{validationError}</Text>
          </Box>
        )}

        <Box flexDirection="column" marginTop={tightLayout ? 0 : 1}>
          <Text>
            <Text bold>Provider: </Text>
            <Text color={theme.suggestion}>{providerDisplayName}</Text>
          </Text>

          {selectedProvider === 'azure' && (
            <Text>
              <Text bold>Resource Name: </Text>
              <Text color={theme.suggestion}>{resourceName}</Text>
            </Text>
          )}

          {selectedProvider === 'ollama' && (
            <Text>
              <Text bold>Server URL: </Text>
              <Text color={theme.suggestion}>{ollamaBaseUrl}</Text>
            </Text>
          )}

          {selectedProvider === 'custom-openai' && !tightLayout && (
            <Text>
              <Text bold>API Base URL: </Text>
              <Text color={theme.suggestion}>{customBaseUrl}</Text>
            </Text>
          )}

          <Text>
            <Text bold>Model: </Text>
            <Text color={theme.suggestion}>{selectedModel}</Text>
          </Text>

          {!tightLayout && maxTokens && (
            <Text>
              <Text bold>Max Tokens: </Text>
              <Text color={theme.suggestion}>{maxTokens}</Text>
            </Text>
          )}

          <Text>
            <Text bold>Context Length: </Text>
            <Text color={theme.suggestion}>
              {CONTEXT_LENGTH_OPTIONS.find(opt => opt.value === contextLength)
                ?.label || `${contextLength.toLocaleString()} tokens`}
            </Text>
          </Text>

          {!tightLayout && supportsReasoningEffort && (
            <Text>
              <Text bold>Reasoning Effort: </Text>
              <Text color={theme.suggestion}>{reasoningEffort}</Text>
            </Text>
          )}

          {compactLayout && tightLayout && maxTokens && (
            <Text dimColor>Max Tokens: {maxTokens}</Text>
          )}
        </Box>

        <Box marginTop={tightLayout ? 0 : 1}>
          <Text dimColor>
            Press <Text color={theme.suggestion}>Esc</Text> to go back or{' '}
            <Text color={theme.suggestion}>Enter</Text> to save configuration
          </Text>
        </Box>
      </Box>
    </ScreenFrame>
  )
}
