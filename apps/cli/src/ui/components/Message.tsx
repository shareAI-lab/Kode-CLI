import { Box, Text } from 'ink'
import * as React from 'react'
import type {
  AssistantMessage,
  Message as CoreMessage,
  UserMessage,
} from '#core/query'
import type {
  ContentBlock,
  DocumentBlockParam,
  ImageBlockParam,
  TextBlockParam,
  ThinkingBlockParam,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import { Tool } from '#core/tooling/Tool'
import { logError } from '#core/utils/log'
import { getTheme } from '#core/utils/theme'
import { SentryErrorBoundary } from './SentryErrorBoundary'
import { UserToolResultMessage } from './messages/UserToolResultMessage/UserToolResultMessage'
import { AssistantToolUseMessage } from './messages/AssistantToolUseMessage'
import { AssistantTextMessage } from './messages/AssistantTextMessage'
import { UserTextMessage } from './messages/UserTextMessage'
import { UserImageMessage } from './messages/UserImageMessage'
import { NormalizedMessage } from '#core/utils/messages'
import { AssistantThinkingMessage } from './messages/AssistantThinkingMessage'
import { AssistantRedactedThinkingMessage } from './messages/AssistantRedactedThinkingMessage'
import { useTerminalSize } from '#ui-ink/hooks/useTerminalSize'
import type { ToolUseLikeBlockParam } from '#core/utils/anthropic'
import { computeAvailableColumns } from '#ui-ink/primitives/layout/viewportColumns'

type Props = {
  message: UserMessage | AssistantMessage
  messages: NormalizedMessage[]
  // NOTE: addMargin is handled at this layer to keep message spacing consistent in the TUI.
  addMargin: boolean
  tools: Tool[]
  verbose: boolean
  debug: boolean
  erroredToolUseIDs: Set<string>
  inProgressToolUseIDs: Set<string>
  unresolvedToolUseIDs: Set<string>
  shouldAnimate: boolean
  shouldShowDot: boolean
  width?: number | string
  isTransient?: boolean
}

export const Message = React.memo(function Message({
  message,
  messages,
  addMargin,
  tools,
  verbose,
  debug,
  erroredToolUseIDs,
  inProgressToolUseIDs,
  unresolvedToolUseIDs,
  shouldAnimate,
  shouldShowDot,
  width,
  isTransient,
}: Props): React.ReactNode {
  // Assistant message
  if (message.type === 'assistant') {
    return (
      <Box flexDirection="column" width="100%">
        {groupAssistantContentBlocks(message, message.message.content).map(
          (item, index) => (
            <SentryErrorBoundary
              key={
                item.type === 'group'
                  ? `${message.uuid}:group:${item.name}:${index}`
                  : getContentBlockRenderKey(message, item.block, index)
              }
            >
              {item.type === 'group' ? (
                <AssistantToolUseGroupMessage
                  name={item.name}
                  params={item.blocks}
                />
              ) : (
                <AssistantMessage
                  key={getContentBlockRenderKey(message, item.block, index)}
                  param={
                    item.block as Parameters<
                      typeof AssistantMessage
                    >[0]['param']
                  }
                  costUSD={message.costUSD}
                  durationMs={message.durationMs}
                  addMargin={addMargin}
                  tools={tools}
                  debug={debug}
                  options={{ verbose }}
                  erroredToolUseIDs={erroredToolUseIDs}
                  inProgressToolUseIDs={inProgressToolUseIDs}
                  unresolvedToolUseIDs={unresolvedToolUseIDs}
                  shouldAnimate={shouldAnimate}
                  shouldShowDot={shouldShowDot}
                  width={width}
                  isTransient={isTransient}
                />
              )}
            </SentryErrorBoundary>
          ),
        )}
      </Box>
    )
  }

  // User message
  // NOTE: legacy user messages may store content as a string; normalize to blocks here.
  const content =
    typeof message.message.content === 'string'
      ? [{ type: 'text', text: message.message.content } as TextBlockParam]
      : message.message.content
  return (
    <Box flexDirection="column" width="100%">
      {content.map((_, index) => (
        <UserMessage
          key={getContentBlockRenderKey(message, _, index)}
          message={message}
          messages={messages}
          addMargin={addMargin}
          tools={tools}
          param={_ as TextBlockParam}
          options={{ verbose }}
        />
      ))}
    </Box>
  )
})

// Tools whose repeated invocations in one assistant message are visually
// aggregated into a single group row to reduce transcript noise.
const AGGREGATABLE_TOOL_NAMES = new Set([
  'web_search',
  'WebSearch',
  'Fetch',
  'fetch',
])

export function normalizeAggregatedToolName(name: string): string {
  if (name === 'web_search' || name === 'WebSearch') return 'Search'
  if (name === 'fetch') return 'Fetch'
  return name
}

type GroupedContentItem =
  | { type: 'single'; block: unknown }
  | { type: 'group'; name: string; blocks: unknown[] }

export function groupAssistantContentBlocks(
  _message: UserMessage | AssistantMessage,
  content: unknown[],
): GroupedContentItem[] {
  const out: GroupedContentItem[] = []
  let currentGroup: { name: string; blocks: unknown[] } | null = null
  const flush = () => {
    if (currentGroup) {
      out.push({
        type: 'group',
        name: currentGroup.name,
        blocks: currentGroup.blocks,
      })
      currentGroup = null
    }
  }
  for (const block of content) {
    const record = asRecord(block)
    const isAggregatable =
      record?.type === 'tool_use' &&
      typeof record.name === 'string' &&
      AGGREGATABLE_TOOL_NAMES.has(record.name)
    if (!isAggregatable) {
      flush()
      out.push({ type: 'single', block })
      continue
    }
    const name = record!.name as string
    if (currentGroup && currentGroup.name === name) {
      currentGroup.blocks.push(block)
    } else {
      flush()
      currentGroup = { name, blocks: [block] }
    }
  }
  flush()
  return out
}

// Kept for tests only.
export const __groupAssistantContentForTests = (
  content: unknown[],
): GroupedContentItem[] =>
  groupAssistantContentBlocks(
    {
      type: 'assistant',
      uuid: 'test',
      costUSD: 0,
      durationMs: 0,
      message: {
        id: 'm',
        model: 'x',
        role: 'assistant',
        type: 'message',
        content,
        usage: {},
      },
    } as unknown as AssistantMessage,
    content,
  )
export const __normalizeAggregatedToolNameForTests = normalizeAggregatedToolName

function summarizeGroupedToolInput(block: unknown): string {
  const record = asRecord(block) as { input?: unknown } | null
  const input = record?.input
  if (typeof input === 'string') return input
  if (input && typeof input === 'object') {
    const rec = input as Record<string, unknown>
    const primary = rec.query ?? rec.url ?? rec.path ?? rec.description
    if (typeof primary === 'string') return primary
    return JSON.stringify(rec).slice(0, 120)
  }
  return ''
}

function AssistantToolUseGroupMessage({
  name,
  params,
}: {
  name: string
  params: unknown[]
}): React.ReactNode {
  const theme = getTheme()
  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="row" width="100%">
        <Text color={theme.secondaryText}>
          {normalizeAggregatedToolName(name)} x {params.length}
        </Text>
      </Box>
      {params.map((block, index) => {
        const record = asRecord(block) as { id?: string } | null
        const summary = summarizeGroupedToolInput(block)
        if (!summary) return null
        return (
          <Box
            key={record?.id ?? String(index)}
            flexDirection="row"
            width="100%"
          >
            <Text color={theme.text} wrap="truncate-end">
              {summary}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  return value as Record<string, unknown>
}

function getBlockType(value: unknown): string {
  const record = asRecord(value)
  return record && typeof record.type === 'string' ? record.type : ''
}

function getContentBlockRenderKey(
  message: UserMessage | AssistantMessage,
  block: unknown,
  index: number,
): string {
  const record = asRecord(block)
  const type = getBlockType(block) || 'block'
  const blockID =
    record && typeof record.id === 'string'
      ? record.id
      : record && typeof record.tool_use_id === 'string'
        ? record.tool_use_id
        : null

  return blockID
    ? `${message.uuid}:${type}:${blockID}`
    : `${message.uuid}:${type}:${index}`
}

function UserMessage({
  message,
  messages,
  addMargin,
  tools,
  param,
  options: { verbose },
}: {
  message: UserMessage
  messages: CoreMessage[]
  addMargin: boolean
  tools: Tool[]
  param:
    | TextBlockParam
    | DocumentBlockParam
    | ImageBlockParam
    | ToolUseBlockParam
    | ToolResultBlockParam
  options: {
    verbose: boolean
  }
  key?: React.Key
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const toolResultWidth = computeAvailableColumns({
    columns,
    reservedColumns: 5,
  })
  switch (param.type) {
    case 'text':
      return <UserTextMessage addMargin={addMargin} param={param} />
    case 'image':
      return <UserImageMessage addMargin={addMargin} param={param} />
    case 'tool_result':
      return (
        <UserToolResultMessage
          param={param}
          message={message}
          messages={messages}
          tools={tools}
          verbose={verbose}
          width={toolResultWidth}
        />
      )
  }
  return null
}

function AssistantMessage({
  param,
  costUSD,
  durationMs,
  addMargin,
  tools,
  debug,
  options: { verbose },
  erroredToolUseIDs,
  inProgressToolUseIDs,
  unresolvedToolUseIDs,
  shouldAnimate,
  shouldShowDot,
  width,
  isTransient,
}: {
  param:
    | ContentBlock
    | TextBlockParam
    | ImageBlockParam
    | ThinkingBlockParam
    | ToolUseLikeBlockParam
    | ToolResultBlockParam
  costUSD: number
  durationMs: number
  addMargin: boolean
  tools: Tool[]
  debug: boolean
  options: {
    verbose: boolean
  }
  erroredToolUseIDs: Set<string>
  inProgressToolUseIDs: Set<string>
  unresolvedToolUseIDs: Set<string>
  shouldAnimate: boolean
  shouldShowDot: boolean
  width?: number | string
  isTransient?: boolean
  key?: React.Key
}): React.ReactNode {
  const type = getBlockType(param)
  switch (type) {
    case 'tool_use':
    case 'server_tool_use':
    case 'mcp_tool_use': {
      const normalizedParam: ToolUseBlockParam =
        type === 'tool_use'
          ? (param as ToolUseBlockParam)
          : { ...(param as ToolUseBlockParam), type: 'tool_use' }
      return (
        <AssistantToolUseMessage
          param={normalizedParam}
          costUSD={costUSD}
          durationMs={durationMs}
          addMargin={addMargin}
          tools={tools}
          debug={debug}
          verbose={verbose}
          erroredToolUseIDs={erroredToolUseIDs}
          inProgressToolUseIDs={inProgressToolUseIDs}
          unresolvedToolUseIDs={unresolvedToolUseIDs}
          shouldAnimate={shouldAnimate}
          shouldShowDot={shouldShowDot}
        />
      )
    }
    case 'text':
      return (
        <AssistantTextMessage
          param={param as TextBlockParam}
          costUSD={costUSD}
          durationMs={durationMs}
          debug={debug}
          addMargin={addMargin}
          shouldShowDot={shouldShowDot}
          verbose={verbose}
          width={width}
          isTransient={isTransient}
        />
      )
    case 'redacted_thinking':
      return <AssistantRedactedThinkingMessage addMargin={addMargin} />
    case 'thinking':
      return (
        <AssistantThinkingMessage
          addMargin={addMargin}
          param={param as ThinkingBlockParam}
          // Live provider reasoning is rendered by AssistantStreamPreview.
          // Once it becomes a transcript item it must remain still; otherwise
          // its spinner keeps repainting completed terminal history.
          shouldAnimate={shouldAnimate && Boolean(isTransient)}
        />
      )
    default:
      logError(`Unable to render message type: ${type || '(unknown)'}`)
      return null
  }
}
