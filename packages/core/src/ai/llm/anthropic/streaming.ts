import type Anthropic from '@anthropic-ai/sdk'
import type { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk'
import type { AnthropicVertex } from '@anthropic-ai/vertex-sdk'
import {
  setRequestStatus,
  setRequestInputTokens,
  updateRequestTokens,
} from '#core/utils/requestStatus'
import { debug as debugLogger } from '#core/utils/debugLogger'
import { parseToolUsePartialJsonOrThrow } from '#core/utils/toolUsePartialJson'
import {
  emitAssistantStreamUpdate,
  type AssistantStreamUpdateOptions,
} from '@kode/tool-interface/assistantStreamUpdate'

type AnthropicClient = Anthropic | AnthropicBedrock | AnthropicVertex

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  if (Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export async function createAnthropicStreamingMessage(
  anthropic: AnthropicClient,
  params: Anthropic.Beta.Messages.MessageCreateParams,
  signal: AbortSignal,
  options?: AssistantStreamUpdateOptions & {
    onStreamEvent?: (event: unknown) => void
  },
): Promise<any> {
  emitAssistantStreamUpdate(options, { type: 'start' })

  const stream = await anthropic.beta.messages.create(
    {
      ...params,
      stream: true,
    },
    {
      signal: signal, // CRITICAL: Connect the AbortSignal to API call
    },
  )

  let finalResponse: any | null = null
  let messageStartEvent: any = null
  const contentBlocks: any[] = []
  const inputJSONBuffers = new Map<number, string>()
  let usage: any = null
  let stopReason: string | null = null
  let stopSequence: string | null = null
  let hasMarkedStreaming = false
  let outputTokenCount = 0

  for await (const event of stream) {
    try {
      options?.onStreamEvent?.(event)
    } catch {
      /* no-op */
    }

    if (signal.aborted) {
      debugLogger.flow('STREAM_ABORTED', {
        eventType: event.type,
        timestamp: Date.now(),
      })
      throw new Error('Request was cancelled')
    }

    switch (event.type) {
      case 'message_start':
        messageStartEvent = event
        finalResponse = {
          ...event.message,
          content: [], // Will be populated from content blocks
        }
        if (event.message?.usage?.input_tokens) {
          setRequestInputTokens(event.message.usage.input_tokens)
        }
        break

      case 'content_block_start':
        contentBlocks[event.index] = { ...event.content_block }
        // Initialize JSON buffer for tool_use blocks
        {
          const contentBlock = asRecord(event.content_block)
          const blockType = contentBlock?.type
          if (
            blockType === 'tool_use' ||
            blockType === 'server_tool_use' ||
            blockType === 'mcp_tool_use'
          ) {
            setRequestStatus({
              kind: 'tool',
              detail:
                typeof contentBlock?.name === 'string'
                  ? contentBlock.name
                  : undefined,
            })
            inputJSONBuffers.set(event.index, '')
          }
        }
        break

      case 'content_block_delta':
        const blockIndex = event.index

        // Ensure content block exists
        if (!contentBlocks[blockIndex]) {
          contentBlocks[blockIndex] = {
            type:
              event.delta.type === 'text_delta'
                ? 'text'
                : event.delta.type === 'thinking_delta'
                  ? 'thinking'
                  : 'tool_use',
            text: event.delta.type === 'text_delta' ? '' : undefined,
            thinking: event.delta.type === 'thinking_delta' ? '' : undefined,
          }
          if (event.delta.type === 'input_json_delta') {
            inputJSONBuffers.set(blockIndex, '')
          }
        }

        if (event.delta.type === 'thinking_delta') {
          if (event.delta.thinking) {
            emitAssistantStreamUpdate(options, {
              type: 'thinking_delta',
              delta: event.delta.thinking,
            })
          }
          contentBlocks[blockIndex].thinking =
            (contentBlocks[blockIndex].thinking ?? '') + event.delta.thinking
        } else if (event.delta.type === 'signature_delta') {
          contentBlocks[blockIndex].signature =
            (contentBlocks[blockIndex].signature ?? '') + event.delta.signature
        } else if (event.delta.type === 'text_delta') {
          if (event.delta.text) {
            emitAssistantStreamUpdate(options, {
              type: 'text_delta',
              delta: event.delta.text,
            })
          }
          if (!hasMarkedStreaming) {
            setRequestStatus({ kind: 'streaming' })
            hasMarkedStreaming = true
          }
          contentBlocks[blockIndex].text += event.delta.text
          outputTokenCount++
          updateRequestTokens(outputTokenCount)
        } else if (event.delta.type === 'input_json_delta') {
          const currentBuffer = inputJSONBuffers.get(blockIndex) || ''
          const nextBuffer = currentBuffer + event.delta.partial_json
          inputJSONBuffers.set(blockIndex, nextBuffer)

          const trimmed = nextBuffer.trim()
          if (trimmed.length === 0) {
            contentBlocks[blockIndex].input = {}
            break
          }

          contentBlocks[blockIndex].input =
            parseToolUsePartialJsonOrThrow(nextBuffer) ?? {}
        }
        break

      case 'message_delta':
        if (event.delta.stop_reason) stopReason = event.delta.stop_reason
        if (event.delta.stop_sequence) stopSequence = event.delta.stop_sequence
        if (event.usage) {
          usage = { ...usage, ...event.usage }
          if (event.usage.output_tokens) {
            updateRequestTokens(event.usage.output_tokens)
          }
        }
        break

      case 'content_block_stop':
        const stopIndex = event.index
        const block = contentBlocks[stopIndex]

        if (
          (block?.type === 'tool_use' ||
            block?.type === 'server_tool_use' ||
            block?.type === 'mcp_tool_use') &&
          inputJSONBuffers.has(stopIndex)
        ) {
          const jsonStr = inputJSONBuffers.get(stopIndex) ?? ''
          if (block.input === undefined) {
            const trimmed = jsonStr.trim()
            if (trimmed.length === 0) {
              block.input = {}
            } else {
              block.input = parseToolUsePartialJsonOrThrow(jsonStr) ?? {}
            }
          }

          inputJSONBuffers.delete(stopIndex)
        }
        break

      case 'message_stop':
        // Clear any remaining buffers
        inputJSONBuffers.clear()
        break
    }

    if (event.type === 'message_stop') {
      break
    }
  }

  if (!finalResponse || !messageStartEvent) {
    throw new Error('Stream ended without proper message structure')
  }

  // Construct the final response
  finalResponse = {
    ...messageStartEvent.message,
    content: contentBlocks.filter(Boolean),
    stop_reason: stopReason,
    stop_sequence: stopSequence,
    usage: {
      ...messageStartEvent.message.usage,
      ...usage,
    },
  }

  return finalResponse
}
