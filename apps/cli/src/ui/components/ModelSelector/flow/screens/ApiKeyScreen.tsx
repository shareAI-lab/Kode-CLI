import React from 'react'
import { Box, Text } from 'ink'

import TextInput from '#ui-ink/components/TextInput'
import {
  ScreenFrame,
  type ScreenExitState,
} from '#ui-ink/primitives/layout/ScreenFrame'

type Props = {
  theme: any
  exitState: ScreenExitState
  terminalColumns: number
  compactLayout: boolean
  tightLayout: boolean
  containerPaddingY: number
  containerGap: number
  selectedProvider: string
  apiKey: string
  cursorOffset: number
  handleApiKeyChange: (value: string) => void
  handleApiKeySubmit: (value: string) => void
  handleCursorOffsetChange: (offset: number) => void
  isLoadingModels: boolean
  modelLoadError: string | null
  getProviderLabel: (provider: string, modelCount: number) => string
}

export function ApiKeyScreen({
  theme,
  exitState,
  terminalColumns,
  compactLayout,
  tightLayout,
  containerPaddingY,
  containerGap,
  selectedProvider,
  apiKey,
  cursorOffset,
  handleApiKeyChange,
  handleApiKeySubmit,
  handleCursorOffsetChange,
  isLoadingModels,
  modelLoadError,
  getProviderLabel,
}: Props) {
  const inputColumns = Math.max(1, Math.min(80, terminalColumns - 10))
  const providerDisplayName = getProviderLabel(selectedProvider, 0).split(
    ' (',
  )[0]

  return (
    <ScreenFrame
      title="Credential Source / 凭据来源"
      exitState={exitState}
      paddingX={tightLayout || compactLayout ? 1 : 2}
      paddingY={containerPaddingY}
      gap={containerGap}
    >
      <Box flexDirection="column" gap={containerGap}>
        <Text bold wrap="truncate-end">
          Environment variable for {providerDisplayName}:
        </Text>
        <Text color={theme.secondaryText} wrap="truncate-end">
          Enter the variable name, not its secret value. Kode saves only this
          reference and never shows the key here.
        </Text>

        <TextInput
          placeholder="OPENAI_API_KEY"
          value={apiKey}
          onChange={handleApiKeyChange}
          onSubmit={handleApiKeySubmit}
          columns={inputColumns}
          maxHeight={1}
          cursorOffset={cursorOffset}
          onChangeCursorOffset={handleCursorOffsetChange}
          showCursor={!isLoadingModels}
          focus={!isLoadingModels}
        />

        {isLoadingModels ? (
          <Box flexDirection="column">
            <Text color={theme.suggestion}>Discovering available models…</Text>
          </Box>
        ) : null}

        {modelLoadError ? (
          <Box flexDirection="column">
            <Text color={theme.error} wrap="truncate-end">
              {modelLoadError}
            </Text>
            <Text color={theme.secondaryText} wrap="truncate-end">
              Correct the reference, or press Enter to configure the model ID
              without discovery.
            </Text>
          </Box>
        ) : null}

        <Box marginTop={tightLayout ? 0 : 1}>
          <Text color={theme.secondaryText} wrap="truncate-end">
            Enter use reference & enter model ID · Tab discover models · Esc
            back
          </Text>
        </Box>
      </Box>
    </ScreenFrame>
  )
}
