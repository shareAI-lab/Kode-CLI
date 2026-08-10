import React from 'react'
import { Box, Newline, Text } from 'ink'

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
  apiKeyEnv?: string
  apiKey: string
  cursorOffset: number
  handleApiKeyChange: (value: string) => void
  handleApiKeySubmit: (value: string) => void
  handleCursorOffsetChange: (offset: number) => void
  apiKeyCleanedNotification: boolean
  isLoadingModels: boolean
  providerBaseUrl: string
  modelLoadError: string | null
  formatApiKeyDisplay: (key: string) => string
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
  apiKeyEnv,
  apiKey,
  cursorOffset,
  handleApiKeyChange,
  handleApiKeySubmit,
  handleCursorOffsetChange,
  apiKeyCleanedNotification,
  isLoadingModels,
  providerBaseUrl,
  modelLoadError,
  formatApiKeyDisplay,
  getProviderLabel,
}: Props) {
  const modelTypeText = 'this model profile'
  const apiKeyInputColumns = Math.max(1, Math.min(80, terminalColumns - 10))
  const descriptionWidth = Math.max(1, Math.min(70, terminalColumns - 10))
  const providerDisplayName = getProviderLabel(selectedProvider, 0).split(
    ' (',
  )[0]
  const skipsValidation =
    selectedProvider === 'minimax' || selectedProvider === 'minimax-coding'

  const providerHint = (() => {
    if (tightLayout) return null

    if (selectedProvider === 'kimi') {
      return (
        <Text color={theme.secondaryText}>
          Tip: Get your API key from:{' '}
          <Text color={theme.suggestion}>
            https://platform.moonshot.cn/console/api-keys
          </Text>
        </Text>
      )
    }
    if (selectedProvider === 'deepseek') {
      return (
        <Text color={theme.secondaryText}>
          Tip: Get your API key from:{' '}
          <Text color={theme.suggestion}>
            https://platform.deepseek.com/api_keys
          </Text>
        </Text>
      )
    }
    if (selectedProvider === 'siliconflow') {
      return (
        <Text color={theme.secondaryText}>
          Tip: Get your API key from:{' '}
          <Text color={theme.suggestion}>
            https://cloud.siliconflow.cn/i/oJWsm6io
          </Text>
        </Text>
      )
    }
    if (selectedProvider === 'qwen') {
      return (
        <Text color={theme.secondaryText}>
          Tip: Get your API key from:{' '}
          <Text color={theme.suggestion}>
            https://bailian.console.aliyun.com/?tab=model#/api-key
          </Text>
        </Text>
      )
    }
    if (selectedProvider === 'glm') {
      return (
        <Text color={theme.secondaryText}>
          Tip: Get your API key from:{' '}
          <Text color={theme.suggestion}>
            https://open.bigmodel.cn (API Keys section)
          </Text>
        </Text>
      )
    }
    if (selectedProvider === 'glm-coding') {
      return (
        <Text color={theme.secondaryText}>
          Tip: This is for GLM Coding Plan API.{' '}
          <Text color={theme.suggestion}>
            Use the same API key as regular GLM
          </Text>
          <Newline />
          <Text dimColor>
            Note: This uses a special endpoint for coding tasks.
          </Text>
        </Text>
      )
    }
    if (selectedProvider === 'minimax') {
      return (
        <Text color={theme.secondaryText}>
          Tip: Get your API key from:{' '}
          <Text color={theme.suggestion}>
            https://www.minimax.io/platform/user-center/basic-information
          </Text>
        </Text>
      )
    }
    if (selectedProvider === 'minimax-coding') {
      return (
        <Text color={theme.secondaryText}>
          Tip: Get your Coding Plan API key from:{' '}
          <Text color={theme.suggestion}>
            https://platform.minimaxi.com/user-center/payment/coding-plan
          </Text>
          <Newline />
          <Text dimColor>
            Note: This requires a MiniMax Coding Plan subscription.
          </Text>
        </Text>
      )
    }
    if (selectedProvider === 'baidu-qianfan') {
      return (
        <Text color={theme.secondaryText}>
          Tip: Get your API key from:{' '}
          <Text color={theme.suggestion}>
            https://console.bce.baidu.com/iam/#/iam/accesslist
          </Text>
        </Text>
      )
    }
    if (selectedProvider === 'openai') {
      return (
        <Text color={theme.secondaryText}>
          Tip: Get your API key from:{' '}
          <Text color={theme.suggestion}>
            https://platform.openai.com/api-keys
          </Text>
        </Text>
      )
    }
    if (selectedProvider === 'anthropic') {
      return (
        <Text color={theme.secondaryText}>
          Tip: Get your API key from your provider dashboard.
        </Text>
      )
    }

    return null
  })()

  return (
    <ScreenFrame
      title="API Key Setup"
      exitState={exitState}
      paddingX={tightLayout || compactLayout ? 1 : 2}
      paddingY={containerPaddingY}
      gap={containerGap}
    >
      <Box flexDirection="column" gap={containerGap}>
        <Text bold>
          Configure {providerDisplayName} credentials for {modelTypeText}:
        </Text>

        <Box
          flexDirection="column"
          width={tightLayout ? undefined : descriptionWidth}
        >
          {tightLayout ? (
            <Text color={theme.secondaryText}>
              Used only for this session. It is not saved in configuration.
            </Text>
          ) : (
            <>
              <Text color={theme.secondaryText}>
                {apiKeyEnv
                  ? `Set ${apiKeyEnv} in the current environment before saving. This field is only for one-time validation; Kode never stores API keys.`
                  : `Used only to validate ${selectedProvider}. Kode never stores API keys.`}
              </Text>
              {providerHint ? <Box marginTop={1}>{providerHint}</Box> : null}
            </>
          )}
        </Box>

        <Box flexDirection="column">
          <TextInput
            placeholder="Paste your API key here..."
            value={apiKey}
            displayValue={formatApiKeyDisplay(apiKey)}
            onChange={handleApiKeyChange}
            onSubmit={handleApiKeySubmit}
            mask="*"
            columns={apiKeyInputColumns}
            maxHeight={1}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={handleCursorOffsetChange}
            showCursor={!isLoadingModels}
            focus={!isLoadingModels}
          />
        </Box>

        {apiKeyCleanedNotification && !tightLayout && (
          <Box marginTop={1}>
            <Text color={theme.success}>
              ✓ API key cleaned: trimmed whitespace
            </Text>
          </Box>
        )}

        {!tightLayout && (
          <Box marginTop={1}>
            <Text>
              <Text color={theme.suggestion} dimColor={!apiKey}>
                [Submit API Key]
              </Text>
              <Text>
                {' '}
                - Press Enter to{' '}
                {skipsValidation ? 'continue' : 'validate and continue'}
              </Text>
            </Text>
          </Box>
        )}

        {isLoadingModels && (
          <Box marginTop={tightLayout ? 0 : 1} flexDirection="column">
            <Text color={theme.suggestion}>Validating API key…</Text>
            {!tightLayout && modelLoadError ? (
              <Text dimColor>{modelLoadError}</Text>
            ) : null}
            {!tightLayout && providerBaseUrl ? (
              <Text dimColor>Endpoint: {providerBaseUrl}</Text>
            ) : null}
          </Box>
        )}

        {modelLoadError && !isLoadingModels && (
          <Box marginTop={tightLayout ? 0 : 1} flexDirection="column">
            <Text color={theme.error}>
              Validation failed{tightLayout ? `: ${modelLoadError}` : ''}
            </Text>
            {!tightLayout ? (
              <>
                <Text color={theme.error}>{modelLoadError}</Text>
                <Text color={theme.warning}>
                  Please check your API key and try again.
                </Text>
              </>
            ) : null}
          </Box>
        )}

        <Box marginTop={tightLayout ? 0 : 1}>
          <Text dimColor>
            Press <Text color={theme.suggestion}>Enter</Text> to continue,{' '}
            <Text color={theme.suggestion}>Tab</Text> to{' '}
            {selectedProvider === 'anthropic' ||
            selectedProvider === 'kimi' ||
            selectedProvider === 'deepseek' ||
            selectedProvider === 'qwen' ||
            selectedProvider === 'glm' ||
            selectedProvider === 'glm-coding' ||
            selectedProvider === 'minimax' ||
            selectedProvider === 'minimax-coding' ||
            selectedProvider === 'baidu-qianfan' ||
            selectedProvider === 'siliconflow' ||
            selectedProvider === 'custom-openai'
              ? 'skip to manual model input'
              : 'skip using a key'}
            , or <Text color={theme.suggestion}>Esc</Text> to go back
          </Text>
        </Box>
      </Box>
    </ScreenFrame>
  )
}
