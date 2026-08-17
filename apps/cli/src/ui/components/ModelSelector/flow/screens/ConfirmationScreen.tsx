import React from 'react'
import { Box, Text } from 'ink'

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
  apiKeyEnv?: string
  hasStoredApiKey: boolean
  validationError: string | null
  activateAsMain: boolean
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
  apiKeyEnv,
  hasStoredApiKey,
  validationError,
  activateAsMain,
  getProviderLabel,
}: Props) {
  // Show model profile being created

  // Get provider display name
  const providerDisplayName = getProviderLabel(selectedProvider, 0).split(
    ' (',
  )[0]
  const showsCredential = selectedProvider !== 'ollama'

  return (
    <ScreenFrame
      title="Configuration Confirmation"
      exitState={exitState}
      paddingX={tightLayout || compactLayout ? 1 : 2}
      paddingY={containerPaddingY}
      gap={containerGap}
    >
      <Box flexDirection="column" gap={containerGap}>
        <Text bold>Quick configuration / 快速配置</Text>
        {!tightLayout && (
          <Text color={theme.secondaryText}>
            Review the provider, model, and credential source before saving.
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

          {showsCredential && (
            <Text>
              <Text bold>Credential: </Text>
              <Text color={theme.suggestion}>
                {hasStoredApiKey
                  ? 'saved in Kode credential storage'
                  : apiKeyEnv
                    ? `environment variable ${apiKeyEnv}`
                    : '(environment variable required)'}
              </Text>
            </Text>
          )}

          {!tightLayout && (
            <Text color={theme.secondaryText} wrap="truncate-end">
              Advanced controls appear only for values reported by model
              discovery. Tool permissions are configured separately with
              /permissions.
            </Text>
          )}
        </Box>

        <Box flexDirection="column" marginTop={tightLayout ? 0 : 1}>
          <Text>
            <Text bold>Kode main model: </Text>
            <Text color={theme.suggestion}>
              {activateAsMain
                ? 'switch to this model after saving'
                : 'keep the current model'}
            </Text>
          </Text>
          <Text color={theme.secondaryText} wrap="truncate-end">
            ↑/↓ choose switch behavior · Enter save · A advanced settings · Esc
            back
          </Text>
        </Box>
      </Box>
    </ScreenFrame>
  )
}
