import type OpenAI from 'openai'
import { OpenAIStreamError } from '@kode/ai/openai/stream'
import {
  emitAssistantStreamUpdate,
  type AssistantStreamUpdateOptions,
} from '@kode/tool-interface/assistantStreamUpdate'
import { debug as debugLogger } from '../../internal/debug'
import {
  setRequestStatus,
  setRequestInputTokens,
  updateRequestTokens,
} from '../../internal/requestStatus'

export type OpenAIStreamDegradedCompletion = OpenAI.ChatCompletion & {
  __streamDegraded?: true
  __streamDegradationReason?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function getToolCallDeltaIndex(
  toolCall: Record<string, unknown>,
  fallbackIndex: number,
): number {
  const index = toolCall.index
  if (index === undefined || index === null) return fallbackIndex
  if (typeof index === 'number' && Number.isInteger(index) && index >= 0) {
    return index
  }
  throw new Error('OpenAI stream tool_calls delta index must be a number')
}

function mergeStreamingString(previous: string, next: string): string {
  if (!next || previous === next || previous.endsWith(next)) return previous
  if (!previous || next.startsWith(previous)) return next
  return previous + next
}

function mergeToolCallDelta(
  previous: unknown,
  delta: Record<string, unknown>,
): Record<string, unknown> {
  const previousTool = isRecord(previous) ? previous : null
  const previousFunction = isRecord(previousTool?.function)
    ? previousTool.function
    : null
  const merged: Record<string, unknown> = {}
  const mergedFunction: Record<string, unknown> = {}

  if (typeof previousTool?.id === 'string') merged.id = previousTool.id
  if (typeof previousTool?.type === 'string') merged.type = previousTool.type
  if (typeof previousFunction?.name === 'string') {
    mergedFunction.name = previousFunction.name
  }
  if (typeof previousFunction?.arguments === 'string') {
    mergedFunction.arguments = previousFunction.arguments
  }

  // Tool-call metadata is a snapshot field, not streamed text. Some
  // OpenAI-compatible providers repeat it with every arguments delta.
  if (delta.id !== null && delta.id !== undefined) {
    if (typeof delta.id !== 'string') {
      throw new Error('OpenAI stream tool_calls delta id must be a string')
    }
    if (delta.id) merged.id = delta.id
  }
  if (delta.type !== null && delta.type !== undefined) {
    if (typeof delta.type !== 'string') {
      throw new Error('OpenAI stream tool_calls delta type must be a string')
    }
    if (delta.type) merged.type = delta.type
  }

  if (delta.function !== null && delta.function !== undefined) {
    if (!isRecord(delta.function)) {
      throw new Error(
        'OpenAI stream tool_calls delta function must be an object',
      )
    }
    if (delta.function.name !== null && delta.function.name !== undefined) {
      if (typeof delta.function.name !== 'string') {
        throw new Error(
          'OpenAI stream tool_calls delta function name must be a string',
        )
      }
      if (delta.function.name) mergedFunction.name = delta.function.name
    }
    if (
      delta.function.arguments !== null &&
      delta.function.arguments !== undefined
    ) {
      if (typeof delta.function.arguments !== 'string') {
        throw new Error(
          'OpenAI stream tool_calls delta function arguments must be a string',
        )
      }
      const previousArguments =
        typeof mergedFunction.arguments === 'string'
          ? mergedFunction.arguments
          : ''
      const deltaArguments = delta.function.arguments
      // Some providers send the entire accumulated argument value instead of
      // a pure increment. Keep the newest snapshot rather than concatenating
      // its already-seen prefix.
      mergedFunction.arguments = mergeStreamingString(
        previousArguments,
        deltaArguments,
      )
    }
  }

  if (previousFunction || isRecord(delta.function)) {
    merged.function = mergedFunction
  }

  return merged
}

const SNAPSHOT_STRING_FIELDS = new Set([
  'type',
  'id',
  'role',
  'model',
  'object',
  'finish_reason',
  'stop_reason',
  'stop_sequence',
  'service_tier',
  'status',
])

function messageReducer(
  previous: OpenAI.ChatCompletionMessage,
  item: OpenAI.ChatCompletionChunk,
): OpenAI.ChatCompletionMessage {
  const reduce = (acc: any, delta: unknown) => {
    acc = { ...acc }
    if (!isRecord(delta)) return acc

    for (const [key, value] of Object.entries(delta)) {
      if (key === 'tool_calls') {
        if (value === null || value === undefined) continue
        if (!Array.isArray(value)) {
          throw new Error('OpenAI stream tool_calls delta must be an array')
        }

        const accArray = Array.isArray(acc[key]) ? [...acc[key]] : []
        for (let i = 0; i < value.length; i++) {
          const toolCall = value[i]
          if (!isRecord(toolCall)) {
            throw new Error(
              'OpenAI stream tool_calls delta entries must be objects',
            )
          }

          const index = getToolCallDeltaIndex(toolCall, i)
          if (index > accArray.length) {
            throw new Error(
              `OpenAI stream tool_calls delta index ${index} exceeds the next valid index ${accArray.length}`,
            )
          }

          const { index: _index, ...chunkTool } = toolCall
          accArray[index] = mergeToolCallDelta(accArray[index], chunkTool)
        }
        acc[key] = accArray
        continue
      }

      if (acc[key] === undefined || acc[key] === null) {
        acc[key] = value
        //  OpenAI.Chat.Completions.ChatCompletionMessageToolCall does not have a key, .index
        if (Array.isArray(acc[key])) {
          for (const arr of acc[key]) {
            delete arr.index
          }
        }
      } else if (typeof acc[key] === 'string' && typeof value === 'string') {
        if (SNAPSHOT_STRING_FIELDS.has(key)) {
          // Some OpenAI-compatible providers (e.g. mimo) repeat snapshot
          // metadata (type/id/role) with every delta chunk. These fields are
          // idempotent snapshots, not streamed text: overwrite instead of
          // concatenating so the accumulated string cannot grow unbounded.
          acc[key] = value
          continue
        }
        acc[key] = mergeStreamingString(acc[key], value)
      } else if (typeof acc[key] === 'number' && typeof value === 'number') {
        acc[key] = value
      } else if (Array.isArray(acc[key]) && Array.isArray(value)) {
        const accArray = acc[key]
        for (let i = 0; i < value.length; i++) {
          const { index, ...chunkTool } = value[i]
          if (index - accArray.length > 1) {
            throw new Error(
              `OpenAI stream array delta index ${index} exceeds the current length ${accArray.length}`,
            )
          }
          accArray[index] = reduce(accArray[index], chunkTool)
        }
      } else if (isRecord(acc[key]) && isRecord(value)) {
        acc[key] = reduce(acc[key], value)
      }
    }
    return acc
  }

  const choice = item.choices?.[0]
  if (!choice) {
    // chunk contains information about usage and token counts
    return previous
  }
  if (!isRecord(choice.delta)) return previous
  return reduce(previous, choice.delta) as OpenAI.ChatCompletionMessage
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('Request was cancelled')
  }
}

function hasAnyAssistantOutput(message: OpenAI.ChatCompletionMessage): boolean {
  const record = message as unknown as Record<string, unknown>
  return (
    (typeof message.content === 'string' && message.content.length > 0) ||
    (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) ||
    (typeof record.reasoning === 'string' && record.reasoning.length > 0) ||
    (typeof record.reasoning_content === 'string' &&
      record.reasoning_content.length > 0)
  )
}

function getNewReasoningDelta(args: {
  previous: OpenAI.ChatCompletionMessage
  accumulated: OpenAI.ChatCompletionMessage
  delta: unknown
}): string {
  if (!isRecord(args.delta)) return ''

  const previous = args.previous as unknown as Record<string, unknown>
  const accumulated = args.accumulated as unknown as Record<string, unknown>
  const deltas: string[] = []

  for (const field of ['reasoning_content', 'reasoning']) {
    if (typeof args.delta[field] !== 'string') continue

    const before = typeof previous[field] === 'string' ? previous[field] : ''
    const after =
      typeof accumulated[field] === 'string' ? accumulated[field] : ''
    if (!after || after === before) continue

    deltas.push(
      after.startsWith(before) ? after.slice(before.length) : args.delta[field],
    )
  }

  return deltas.join('')
}

export function isOpenAIStreamDegradedResponse(
  response: OpenAI.ChatCompletion,
): response is OpenAIStreamDegradedCompletion {
  return (response as OpenAIStreamDegradedCompletion).__streamDegraded === true
}

export async function handleMessageStream(
  stream: AsyncIterable<OpenAI.ChatCompletionChunk>,
  signal?: AbortSignal,
  options?: AssistantStreamUpdateOptions,
): Promise<OpenAI.ChatCompletion> {
  emitAssistantStreamUpdate(options, { type: 'start' })

  const streamStartTime = Date.now()
  let ttftMs: number | undefined
  let chunkCount = 0
  let errorCount = 0
  let hasMarkedStreaming = false
  let outputTokenCount = 0
  let finishReason: OpenAI.ChatCompletion.Choice['finish_reason'] | null = null
  let degradationReason: string | null = null
  let lastChunkError: unknown = null

  debugLogger.api('OPENAI_STREAM_START', {
    streamStartTime: String(streamStartTime),
  })

  let message = {} as OpenAI.ChatCompletionMessage

  let id: string | undefined
  let model: string | undefined
  let created: number | undefined
  let usage: OpenAI.ChatCompletion['usage'] | undefined
  try {
    throwIfAborted(signal)
    for await (const chunk of stream) {
      try {
        throwIfAborted(signal)
      } catch (error) {
        debugLogger.flow('OPENAI_STREAM_ABORTED', {
          chunkCount,
          timestamp: Date.now(),
        })
        throw error
      }

      chunkCount++

      try {
        if (id === undefined) {
          id = chunk.id
          debugLogger.api('OPENAI_STREAM_ID_RECEIVED', {
            id,
            chunkNumber: String(chunkCount),
          })
        }
        if (model === undefined) {
          model = chunk.model
          debugLogger.api('OPENAI_STREAM_MODEL_RECEIVED', {
            model,
            chunkNumber: String(chunkCount),
          })
        }
        if (created === undefined) {
          created = chunk.created
        }
        if (usage === undefined && chunk.usage) {
          usage = chunk.usage
          if (chunk.usage?.prompt_tokens) {
            setRequestInputTokens(chunk.usage.prompt_tokens)
          }
        }

        const previousMessage = message
        const previousContent =
          typeof previousMessage.content === 'string'
            ? previousMessage.content
            : ''
        message = messageReducer(message, chunk)
        const accumulatedContent =
          typeof message.content === 'string' ? message.content : ''
        const thinkingDelta = getNewReasoningDelta({
          previous: previousMessage,
          accumulated: message,
          delta: chunk?.choices?.[0]?.delta,
        })

        const textDelta = chunk?.choices?.[0]?.delta?.content
        const newTextDelta =
          typeof textDelta === 'string' &&
          accumulatedContent.startsWith(previousContent)
            ? accumulatedContent.slice(previousContent.length)
            : textDelta
        if (thinkingDelta) {
          emitAssistantStreamUpdate(options, {
            type: 'thinking_delta',
            delta: thinkingDelta,
          })
        }
        if (newTextDelta) {
          emitAssistantStreamUpdate(options, {
            type: 'text_delta',
            delta: newTextDelta,
          })
          if (!hasMarkedStreaming) {
            setRequestStatus({ kind: 'streaming' })
            hasMarkedStreaming = true
          }
          outputTokenCount++
          updateRequestTokens(outputTokenCount)
          if (!ttftMs) {
            ttftMs = Date.now() - streamStartTime
            debugLogger.api('OPENAI_STREAM_FIRST_TOKEN', {
              ttftMs: String(ttftMs),
              chunkNumber: String(chunkCount),
            })
          }
        }

        if (chunk?.usage?.completion_tokens) {
          updateRequestTokens(chunk.usage.completion_tokens)
        }
        const chunkFinishReason = chunk?.choices?.[0]?.finish_reason
        if (chunkFinishReason) finishReason = chunkFinishReason
      } catch (chunkError) {
        errorCount++
        lastChunkError = chunkError
        debugLogger.error('OPENAI_STREAM_CHUNK_ERROR', {
          chunkNumber: String(chunkCount),
          errorMessage:
            chunkError instanceof Error
              ? chunkError.message
              : String(chunkError),
          errorType:
            chunkError instanceof Error
              ? chunkError.constructor.name
              : typeof chunkError,
        })
        // Continue processing other chunks
      }
    }

    throwIfAborted(signal)

    if (errorCount > 0 && !hasAnyAssistantOutput(message)) {
      throw new OpenAIStreamError(
        'unexpected_error',
        `OpenAI stream chunk processing failed before any assistant content: ${
          lastChunkError instanceof Error
            ? lastChunkError.message
            : String(lastChunkError ?? 'unknown error')
        }`,
      )
    }

    if (chunkCount === 0 || !hasAnyAssistantOutput(message)) {
      throw new OpenAIStreamError(
        'empty_response',
        'OpenAI stream completed without assistant content or tool calls',
      )
    }

    debugLogger.api('OPENAI_STREAM_COMPLETE', {
      totalChunks: String(chunkCount),
      errorCount: String(errorCount),
      totalDuration: String(Date.now() - streamStartTime),
      ttftMs: String(ttftMs || 0),
      finalMessageId: id ?? 'undefined',
    })
  } catch (streamError) {
    if (
      !(
        streamError instanceof Error &&
        streamError.message === 'Request was cancelled'
      ) &&
      hasAnyAssistantOutput(message)
    ) {
      degradationReason =
        streamError instanceof OpenAIStreamError
          ? streamError.reason
          : streamError instanceof Error
            ? streamError.message
            : String(streamError)
      debugLogger.warn('OPENAI_STREAM_DEGRADED_PARTIAL', {
        reason: degradationReason,
        chunkCount: String(chunkCount),
      })
    } else {
      debugLogger.error('OPENAI_STREAM_FATAL_ERROR', {
        totalChunks: String(chunkCount),
        errorCount: String(errorCount),
        errorMessage:
          streamError instanceof Error
            ? streamError.message
            : String(streamError),
        errorType:
          streamError instanceof Error
            ? streamError.constructor.name
            : typeof streamError,
      })
      throw streamError
    }
  }

  if (errorCount > 0 && !degradationReason) {
    degradationReason =
      lastChunkError instanceof Error
        ? lastChunkError.message
        : 'chunk_processing_error'
  }

  if (id === undefined || created === undefined || model === undefined) {
    throw new OpenAIStreamError(
      'unexpected_error',
      'OpenAI stream completed without required response metadata',
    )
  }

  const completion: OpenAIStreamDegradedCompletion = {
    id,
    created,
    model,
    // Streamed chunks report 'chat.completion.chunk'; the reassembled
    // response is a ChatCompletion.
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason ?? 'stop',
        logprobs: null,
      },
    ],
    usage: usage ?? undefined,
  }

  if (degradationReason) {
    // The stream did not complete cleanly (e.g. MiMo's SSE endpoint can
    // terminate mid tool-call argument). Surface this as a retryable error so
    // the caller's retry loop can re-issue the request through the
    // non-streaming endpoint instead of silently returning partial output.
    throw new OpenAIStreamError(
      'read_error',
      `OpenAI stream degraded: ${degradationReason}`,
    )
  }

  return completion
}
