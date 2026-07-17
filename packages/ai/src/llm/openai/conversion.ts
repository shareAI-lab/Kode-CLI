import OpenAI from 'openai'
import { nanoid } from 'nanoid'
import type { Tool } from '@kode/tool-interface/Tool'
import type { AssistantMessage, UserMessage } from '#core/query'
import { convertAnthropicMessagesToOpenAIMessages as convertAnthropicMessagesToOpenAIMessagesUtil } from '#core/utils/openaiMessageConversion'
import { API_ERROR_MESSAGE_PREFIX } from '../../internal/constants'
import { isOpenAIStreamDegradedResponse } from './stream'
import { normalizeUsage } from './usage'

function mapFinishReasonToStopReason(
  reason: OpenAI.ChatCompletion.Choice['finish_reason'] | null | undefined,
): AssistantMessage['message']['stop_reason'] {
  switch (reason) {
    case 'stop':
      return 'end_turn'
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    default:
      return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function getToolCalls(message: OpenAI.ChatCompletionMessage): unknown[] {
  return Array.isArray(message.tool_calls) ? message.tool_calls : []
}

export function convertAnthropicMessagesToOpenAIMessages(
  messages: (UserMessage | AssistantMessage)[],
): (
  OpenAI.ChatCompletionMessageParam | OpenAI.ChatCompletionToolMessageParam
)[] {
  return convertAnthropicMessagesToOpenAIMessagesUtil(messages as any)
}

export function convertOpenAIResponseToAnthropic(
  response: OpenAI.ChatCompletion,
  tools?: Tool[],
): AssistantMessage['message'] {
  const normalizedUsage = normalizeUsage(response.usage)
  const contentBlocks: AssistantMessage['message']['content'] = []
  const streamDegraded = isOpenAIStreamDegradedResponse(response)
  const message = response.choices?.[0]?.message
  if (!message) {
    if (streamDegraded) {
      contentBlocks.push({
        type: 'text',
        text: formatOpenAIStreamDegradedError(response),
        citations: [],
      })
    }
    return {
      id: nanoid(),
      model: response.model ?? '<openai>',
      role: 'assistant',
      content: contentBlocks,
      stop_reason: mapFinishReasonToStopReason(
        response.choices?.[0]?.finish_reason,
      ),
      stop_sequence: null,
      type: 'message',
      usage: normalizedUsage,
    }
  }

  const toolCalls = getToolCalls(message)
  const droppedToolCalls =
    streamDegraded && toolCalls.length > 0 ? toolCalls.length : 0

  if (!streamDegraded) {
    for (const toolCall of toolCalls) {
      if (!isRecord(toolCall)) continue
      // Some OpenAI-compatible providers omit `type` after stream merge while
      // still providing a function payload. Treat that as a function call.
      const toolCallType =
        typeof toolCall.type === 'string' ? toolCall.type : 'function'
      if (toolCallType !== 'function') continue
      const tool = toolCall.function
      if (!isRecord(tool)) continue
      const toolName = typeof tool.name === 'string' ? tool.name.trim() : ''
      if (!toolName) continue
      const toolArguments =
        typeof tool.arguments === 'string' ? tool.arguments : ''
      let toolArgs: Record<string, unknown> = {}
      if (toolArguments.trim()) {
        try {
          const parsed = JSON.parse(toolArguments)
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            // Non-object arguments cannot be executed safely.
            continue
          }
          toolArgs = parsed as Record<string, unknown>
        } catch {
          // Incomplete/invalid JSON must not become an empty-object tool call
          // (that path silently runs tools with wrong input and stalls loops).
          continue
        }
      }

      contentBlocks.push({
        type: 'tool_use',
        input: toolArgs,
        name: toolName,
        id:
          typeof toolCall.id === 'string' && toolCall.id.length > 0
            ? toolCall.id
            : nanoid(),
      })
    }
  }

  const record = message as unknown as Record<string, unknown>
  if (typeof record.reasoning === 'string' && record.reasoning) {
    contentBlocks.push({
      type: 'thinking',
      thinking: record.reasoning,
      signature: '',
    })
  }

  // NOTE: For deepseek api, the key for its returned reasoning process is reasoning_content
  if (
    typeof record.reasoning_content === 'string' &&
    record.reasoning_content
  ) {
    contentBlocks.push({
      type: 'thinking',
      thinking: record.reasoning_content,
      signature: '',
    })
  }

  if (message.content) {
    contentBlocks.push({
      type: 'text',
      text: message.content,
      citations: [],
    })
  }

  if (streamDegraded) {
    contentBlocks.push({
      type: 'text',
      text: formatOpenAIStreamDegradedError(response, droppedToolCalls),
      citations: [],
    })
  }

  const finalMessage: AssistantMessage['message'] = {
    id: nanoid(),
    model: response.model ?? '<openai>',
    role: 'assistant',
    content: contentBlocks,
    stop_reason: mapFinishReasonToStopReason(
      response.choices?.[0]?.finish_reason,
    ),
    stop_sequence: null,
    type: 'message',
    usage: normalizedUsage,
  }

  return finalMessage
}

function formatOpenAIStreamDegradedError(
  response: OpenAI.ChatCompletion,
  droppedToolCalls = 0,
): string {
  const reason = isOpenAIStreamDegradedResponse(response)
    ? response.__streamDegradationReason
    : undefined
  const reasonText =
    typeof reason === 'string' && reason.length > 0 ? ` (${reason})` : ''
  const toolText =
    droppedToolCalls > 0
      ? ' Partial tool calls were discarded and were not executed.'
      : ''
  return `${API_ERROR_MESSAGE_PREFIX}: OpenAI-compatible stream ended before a complete response${reasonText}.${toolText} Please retry.`
}
