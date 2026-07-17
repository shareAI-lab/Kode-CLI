import type { ChatCompletionStream } from 'openai/lib/ChatCompletionStream'
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
              `Error: An array has an empty value when tool_calls are constructed. tool_calls: ${accArray}; tool: ${value}`,
            )
          }

          const { index: _index, ...chunkTool } = toolCall
          accArray[index] = reduce(accArray[index], chunkTool)
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
        acc[key] += value
      } else if (typeof acc[key] === 'number' && typeof value === 'number') {
        acc[key] = value
      } else if (Array.isArray(acc[key]) && Array.isArray(value)) {
        const accArray = acc[key]
        for (let i = 0; i < value.length; i++) {
          const { index, ...chunkTool } = value[i]
          if (index - accArray.length > 1) {
            throw new Error(
              `Error: An array has an empty value when tool_calls are constructed. tool_calls: ${accArray}; tool: ${value}`,
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

export function isOpenAIStreamDegradedResponse(
  response: OpenAI.ChatCompletion,
): response is OpenAIStreamDegradedCompletion {
  return (response as OpenAIStreamDegradedCompletion).__streamDegraded === true
}

export async function handleMessageStream(
  stream: ChatCompletionStream,
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

  let id, model, created, object, usage
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
        if (!id) {
          id = chunk.id
          debugLogger.api('OPENAI_STREAM_ID_RECEIVED', {
            id,
            chunkNumber: String(chunkCount),
          })
        }
        if (!model) {
          model = chunk.model
          debugLogger.api('OPENAI_STREAM_MODEL_RECEIVED', {
            model,
            chunkNumber: String(chunkCount),
          })
        }
        if (!created) {
          created = chunk.created
        }
        if (!object) {
          object = chunk.object
        }
        if (!usage) {
          usage = chunk.usage
          if (chunk.usage?.prompt_tokens) {
            setRequestInputTokens(chunk.usage.prompt_tokens)
          }
        }

        message = messageReducer(message, chunk)

        const textDelta = chunk?.choices?.[0]?.delta?.content
        if (textDelta) {
          emitAssistantStreamUpdate(options, {
            type: 'text_delta',
            delta: textDelta,
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
      finalMessageId: id || 'undefined',
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

  const completion: OpenAIStreamDegradedCompletion = {
    id,
    created,
    model,
    object,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason ?? 'stop',
        logprobs: undefined,
      },
    ],
    usage,
  }

  if (degradationReason) {
    completion.__streamDegraded = true
    completion.__streamDegradationReason = degradationReason
  }

  return completion
}
