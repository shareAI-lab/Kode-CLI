import React from 'react'
import { Box, Text } from 'ink'

import { Select } from '#ui-ink/components/CustomSelect/select'
import {
  ScreenFrame,
  type ScreenExitState,
} from '#ui-ink/primitives/layout/ScreenFrame'

import {
  type ReasoningEffortOption,
  type RequestStrategyOption,
  MAX_TOKENS_OPTIONS,
} from '../options'

const VIEWPORT_SAFE_MARGIN_ROWS = 1

function isReasoningEffortOption(
  value: string,
): value is ReasoningEffortOption {
  return value === 'low' || value === 'medium' || value === 'high'
}

type Field = {
  name: string
  label: string
  description?: string
  component: 'select' | 'button'
  options?: Array<{ label: string; value: string }>
  defaultValue?: string
}

type Props = {
  theme: any
  exitState: ScreenExitState
  terminalRows: number
  compactLayout: boolean
  tightLayout: boolean
  containerPaddingY: number
  containerGap: number
  selectedModel: string
  formFields: Field[]
  activeFieldIndex: number
  setActiveFieldIndex: (value: number | ((current: number) => number)) => void
  maxTokens: string
  setMaxTokens: (value: string) => void
  setSelectedMaxTokensPreset: (value: number) => void
  setMaxTokensCursorOffset: (value: number) => void
  reasoningEffortOptions: Array<{ label: string; value: ReasoningEffortOption }>
  reasoningEffort: ReasoningEffortOption | null
  setReasoningEffort: (value: ReasoningEffortOption | null) => void
  requestStrategyOptions: Array<{
    label: string
    value: RequestStrategyOption
  }>
  requestStrategy: RequestStrategyOption
  setRequestStrategy: (value: RequestStrategyOption) => void
}

export function ModelParamsScreen({
  theme,
  exitState,
  terminalRows,
  compactLayout,
  tightLayout,
  containerPaddingY,
  containerGap,
  selectedModel,
  formFields,
  activeFieldIndex,
  setActiveFieldIndex,
  maxTokens,
  setMaxTokens,
  setSelectedMaxTokensPreset,
  setMaxTokensCursorOffset,
  reasoningEffortOptions,
  reasoningEffort,
  setReasoningEffort,
  requestStrategyOptions,
  requestStrategy,
  setRequestStrategy,
}: Props) {
  const maxSelectHeight = Math.max(
    3,
    Math.min(
      tightLayout ? 6 : 10,
      terminalRows - (tightLayout ? 12 : 18) - VIEWPORT_SAFE_MARGIN_ROWS,
    ),
  )

  return (
    <ScreenFrame
      title="Advanced settings / 高级设置"
      exitState={exitState}
      paddingX={tightLayout || compactLayout ? 1 : 2}
      paddingY={containerPaddingY}
      gap={containerGap}
    >
      <Box flexDirection="column" gap={containerGap}>
        <Text bold>Advanced settings for {selectedModel}:</Text>
        {!tightLayout && (
          <Text color={theme.secondaryText}>
            {compactLayout
              ? 'Output, reasoning, and compatibility settings.'
              : 'These optional limits are applied only after the provider accepts them. Kode does not expose unsupported temperature or timeout controls here.'}
          </Text>
        )}

        <Box flexDirection="column">
          {formFields.map((field, index) => (
            <Box
              flexDirection="column"
              marginY={tightLayout ? 0 : 1}
              key={field.name}
            >
              <Text
                bold
                color={activeFieldIndex === index ? theme.success : undefined}
              >
                {field.label}
              </Text>
              {!tightLayout &&
              field.component !== 'button' &&
              field.description ? (
                <Text color={theme.secondaryText}>{field.description}</Text>
              ) : null}

              <Box marginY={tightLayout ? 0 : 1}>
                {activeFieldIndex === index ? (
                  field.component === 'select' ? (
                    field.name === 'maxTokens' ? (
                      <Select
                        focusScope={`model-params:${selectedModel}:maxTokens`}
                        options={field.options || []}
                        onChange={value => {
                          const numValue = parseInt(value)
                          setMaxTokens(numValue.toString())
                          setSelectedMaxTokensPreset(numValue)
                          setMaxTokensCursorOffset(numValue.toString().length)
                          setTimeout(() => {
                            setActiveFieldIndex(current =>
                              Math.min(current + 1, formFields.length - 1),
                            )
                          }, 100)
                        }}
                        defaultValue={field.defaultValue}
                        visibleOptionCount={Math.min(10, maxSelectHeight)}
                      />
                    ) : field.name === 'reasoningEffort' ? (
                      <Select
                        focusScope={`model-params:${selectedModel}:reasoningEffort`}
                        options={reasoningEffortOptions}
                        onChange={value => {
                          if (isReasoningEffortOption(value)) {
                            setReasoningEffort(value)
                          }
                          setTimeout(() => {
                            setActiveFieldIndex(current =>
                              Math.min(current + 1, formFields.length - 1),
                            )
                          }, 100)
                        }}
                        defaultValue={reasoningEffort ?? undefined}
                        visibleOptionCount={Math.min(8, maxSelectHeight)}
                      />
                    ) : field.name === 'requestStrategy' ? (
                      <Select
                        focusScope={`model-params:${selectedModel}:requestStrategy`}
                        options={requestStrategyOptions}
                        onChange={value => {
                          setRequestStrategy(value as RequestStrategyOption)
                          setTimeout(() => {
                            setActiveFieldIndex(current =>
                              Math.min(current + 1, formFields.length - 1),
                            )
                          }, 100)
                        }}
                        defaultValue={requestStrategy}
                        visibleOptionCount={Math.min(6, maxSelectHeight)}
                      />
                    ) : null
                  ) : null
                ) : field.name === 'maxTokens' ? (
                  <Text color={theme.secondaryText}>
                    Current:{' '}
                    <Text color={theme.suggestion}>
                      {MAX_TOKENS_OPTIONS.find(
                        opt => opt.value === parseInt(maxTokens),
                      )?.label || `${maxTokens} tokens`}
                    </Text>
                  </Text>
                ) : field.name === 'reasoningEffort' ? (
                  <Text color={theme.secondaryText}>
                    Current:{' '}
                    <Text color={theme.suggestion}>{reasoningEffort}</Text>
                  </Text>
                ) : field.name === 'requestStrategy' ? (
                  <Text color={theme.secondaryText}>
                    Current:{' '}
                    <Text color={theme.suggestion}>
                      {requestStrategyOptions.find(
                        option => option.value === requestStrategy,
                      )?.label ?? requestStrategy}
                    </Text>
                  </Text>
                ) : null}
              </Box>
            </Box>
          ))}

          <Box marginTop={tightLayout ? 0 : 1}>
            <Text color={theme.secondaryText}>
              Tab next · Enter review · Esc back
            </Text>
          </Box>
        </Box>
      </Box>
    </ScreenFrame>
  )
}
