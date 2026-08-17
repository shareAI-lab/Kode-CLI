import { Box, Text } from 'ink'
import React from 'react'
import { logError } from '#core/utils/log'
import { Tool } from '#core/tooling/Tool'
import { Cost } from '#ui-ink/components/Cost'
import { ToolUseLoader } from '#ui-ink/components/ToolUseLoader'
import { getTheme } from '#core/utils/theme'
import { ThinkTool } from '#tools/tools/ai/ThinkTool/ThinkTool'
import { AssistantThinkingMessage } from './AssistantThinkingMessage'
import type { ToolUseLikeBlockParam } from '#core/utils/anthropic'
import { TaskToolMessage } from './TaskToolMessage'
import { resolveToolNameAlias } from '#core/utils/toolNameAliases'

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  if (Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function getSubagentType(input: unknown): string | null {
  const record = asRecord(input)
  const value = record?.subagent_type
  return typeof value === 'string' ? value : null
}

function getTaskStatusLabel(args: {
  isQueued: boolean
  isInProgress: boolean
  isError: boolean
}): string | null {
  if (args.isError) return 'failed'
  if (args.isInProgress) return 'running'
  if (args.isQueued) return 'queued'
  return null
}

type Props = {
  param: ToolUseLikeBlockParam
  costUSD: number
  durationMs: number
  addMargin: boolean
  tools: Tool[]
  debug: boolean
  verbose: boolean
  erroredToolUseIDs: Set<string>
  inProgressToolUseIDs: Set<string>
  unresolvedToolUseIDs: Set<string>
  shouldAnimate: boolean
  shouldShowDot: boolean
}

export function AssistantToolUseMessage({
  param,
  costUSD,
  durationMs,
  addMargin,
  tools,
  debug,
  verbose,
  erroredToolUseIDs,
  inProgressToolUseIDs,
  unresolvedToolUseIDs,
  shouldAnimate,
  shouldShowDot,
}: Props): React.ReactNode {
  const theme = getTheme()
  const resolvedName = resolveToolNameAlias(param.name).resolvedName
  const tool = tools.find(_ => _.name === resolvedName)
  if (!tool) {
    logError(`Tool ${param.name} not found`)
    return null
  }
  const isQueued =
    !inProgressToolUseIDs.has(param.id) && unresolvedToolUseIDs.has(param.id)
  const isError = erroredToolUseIDs.has(param.id)
  const isInProgress = inProgressToolUseIDs.has(param.id)
  const taskStatusLabel =
    tool.name === 'Task'
      ? getTaskStatusLabel({ isQueued, isInProgress, isError })
      : null

  // Handle thinking tool with specialized rendering
  if (tool === ThinkTool) {
    const { thought } = ThinkTool.inputSchema.parse(param.input)
    return (
      <AssistantThinkingMessage
        param={{ thinking: thought, signature: '', type: 'thinking' }}
        addMargin={addMargin}
        shouldAnimate={shouldAnimate && isInProgress}
      />
    )
  }

  const parsedInput = tool.inputSchema.safeParse(param.input)
  const userFacingToolName = tool.userFacingName
    ? tool.userFacingName(parsedInput.success ? parsedInput.data : undefined)
    : tool.name

  const hasToolName = userFacingToolName.trim().length > 0
  const hasInputObject =
    param.input &&
    typeof param.input === 'object' &&
    Object.keys(param.input as { [key: string]: unknown }).length > 0
  const toolMessage = hasInputObject
    ? tool.renderToolUseMessage(param.input as never, { verbose })
    : null
  const hasToolMessage =
    React.isValidElement(toolMessage) ||
    (typeof toolMessage === 'string' && toolMessage.trim().length > 0)

  // Compatibility: tools with empty userFacingName and null/empty tool message
  // should not render a tool-use line at all (e.g., AskUserQuestion/TodoWrite).
  if (!hasToolName && !hasToolMessage) {
    return null
  }

  // Determine colors based on state
  const toolNameColor = isQueued
    ? theme.secondaryText
    : isError
      ? theme.error
      : theme.kode
  const paramColor = theme.secondaryText

  return (
    <Box
      flexDirection="row"
      justifyContent="space-between"
      marginTop={addMargin ? 1 : 0}
      width="100%"
    >
      <Box>
        <Box flexWrap="nowrap">
          {shouldShowDot && (
            <ToolUseLoader
              shouldAnimate={shouldAnimate}
              isUnresolved={unresolvedToolUseIDs.has(param.id)}
              isError={isError}
            />
          )}
          {tool.name === 'Task' && param.input ? (
            <>
              <TaskToolMessage
                agentType={
                  parsedInput.success
                    ? (getSubagentType(parsedInput.data) ?? 'general-purpose')
                    : 'general-purpose'
                }
                bold={!isQueued}
                children={String(userFacingToolName || '')}
              />
              {taskStatusLabel && (
                <Text color={paramColor}> [{taskStatusLabel}]</Text>
              )}
            </>
          ) : (
            hasToolName && (
              <Text color={toolNameColor} bold={!isQueued} wrap="truncate-end">
                {userFacingToolName}
              </Text>
            )
          )}
        </Box>
        <Box flexWrap="nowrap">
          {hasToolMessage &&
            (() => {
              // If the tool returns a React component, render it directly
              if (React.isValidElement(toolMessage)) {
                if (!hasToolName) return toolMessage
                return (
                  <Box flexDirection="row">
                    <Text color={paramColor}>(</Text>
                    {toolMessage}
                    <Text color={paramColor}>)</Text>
                  </Box>
                )
              }

              if (typeof toolMessage !== 'string') return null

              if (!hasToolName) {
                return (
                  <Text color={paramColor} wrap="truncate-end">
                    {toolMessage}
                  </Text>
                )
              }

              // If it's a string, wrap it in Text with dimmed parameters
              return (
                <Text color={paramColor} wrap="truncate-end">
                  ({toolMessage})
                </Text>
              )
            })()}
          {isInProgress && (
            <Text color={paramColor} wrap="truncate-end">
              …
            </Text>
          )}
        </Box>
      </Box>
      <Cost costUSD={costUSD} durationMs={durationMs} debug={debug} />
    </Box>
  )
}
