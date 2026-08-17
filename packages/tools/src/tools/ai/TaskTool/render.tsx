import type { TextBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import React from 'react'
import { Box, Text } from 'ink'

import { formatDuration, formatNumber } from '#core/utils/format'
import { getTheme } from '#core/utils/theme'
import { maybeTruncateVerboseToolOutput } from '#core/utils/toolOutputDisplay'

import type { Input, Output } from './schema'
import { asyncLaunchMessage } from './assistantText'

export function renderTaskToolUseMessage(input: Input): string {
  if (!input.description || !input.prompt) return ''
  return input.description
}

export function renderTaskToolResultMessage(
  output: Output,
  options: { verbose: boolean },
): React.ReactElement {
  const theme = getTheme()
  if (output.status === 'async_launched') {
    const hint = output.prompt
      ? ' (down arrow ↓ to manage · ctrl+o to expand)'
      : ' (down arrow ↓ to manage)'
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text>&nbsp;&nbsp;⎿ &nbsp;</Text>
          <Text>
            Backgrounded agent
            {!options.verbose && <Text dimColor>{hint}</Text>}
          </Text>
        </Box>
        {options.verbose && output.prompt && (
          <Box
            paddingLeft={2}
            borderStyle="single"
            borderLeft
            borderTop={false}
            borderRight={false}
            borderBottom={false}
            borderLeftColor={theme.secondaryBorder}
          >
            <Text color={theme.secondaryText} wrap="wrap">
              {output.prompt}
            </Text>
          </Box>
        )}
      </Box>
    )
  }

  const summary = [
    output.totalToolUseCount === 1
      ? '1 tool use'
      : `${output.totalToolUseCount} tool uses`,
    `${formatNumber(output.totalTokens)} tokens`,
    formatDuration(output.totalDurationMs),
  ]
  return (
    <Box flexDirection="column">
      {options.verbose && output.prompt && (
        <Box
          paddingLeft={2}
          borderStyle="single"
          borderLeft
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderLeftColor={theme.secondaryBorder}
        >
          <Text color={theme.secondaryText} wrap="wrap">
            {
              maybeTruncateVerboseToolOutput(output.prompt, {
                maxLines: 120,
                maxChars: 20_000,
              }).text
            }
          </Text>
        </Box>
      )}
      {options.verbose && output.content.length > 0 && (
        <Box
          paddingLeft={2}
          borderStyle="single"
          borderLeft
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderLeftColor={theme.secondaryBorder}
        >
          <Text wrap="wrap">
            {
              maybeTruncateVerboseToolOutput(
                output.content.map(b => b.text).join('\n'),
                { maxLines: 200, maxChars: 40_000 },
              ).text
            }
          </Text>
        </Box>
      )}
      <Box flexDirection="row">
        <Text>&nbsp;&nbsp;⎿ &nbsp;</Text>
        <Text
          color={output.status === 'failed' ? theme.error : undefined}
          dimColor={output.status !== 'failed'}
        >
          {output.status === 'failed' ? 'Failed' : 'Done'} (
          {summary.join(' · ')})
        </Text>
      </Box>
    </Box>
  )
}

export function renderTaskToolResultForAssistant(output: Output): string {
  if (output.status === 'async_launched')
    return asyncLaunchMessage(output.agentId)
  const text = output.content.map(b => b.text).join('\n')
  return output.status === 'failed'
    ? `Subagent failed: ${output.error}${text ? `\n\n${text}` : ''}`
    : text
}

export function buildAgentIdBlock(agentId: string): TextBlock {
  return {
    type: 'text',
    text: `agentId: ${agentId} (for resuming to continue this agent's work if needed)`,
    citations: [],
  }
}
