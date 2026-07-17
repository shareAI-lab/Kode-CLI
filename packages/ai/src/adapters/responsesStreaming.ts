import { StreamingEvent } from './base'
import type { AiAssistantMessage } from '../internal/messageTypes'
import { setRequestStatus } from '../internal/requestStatus'
import { randomUUID } from 'crypto'
import { createAnthropicUsage } from '@kode/protocol/anthropic'
import {
  emitAssistantStreamUpdate,
  type AssistantStreamUpdateOptions,
} from '@kode/tool-interface/assistantStreamUpdate'

export async function processResponsesStream(
  stream: AsyncGenerator<StreamingEvent>,
  startTime: number,
  fallbackResponseId: string,
  options?: AssistantStreamUpdateOptions,
): Promise<{ assistantMessage: AiAssistantMessage; rawResponse: any }> {
  emitAssistantStreamUpdate(options, { type: 'start' })

  const contentBlocks: any[] = []
  const usage: any = {
    prompt_tokens: 0,
    completion_tokens: 0,
  }

  let responseId = fallbackResponseId
  const pendingToolCalls: any[] = []
  let hasMarkedStreaming = false
  let hasVisibleOutput = false
  let streamError: string | null = null

  const appendThinkingDelta = (delta: string) => {
    const last = contentBlocks[contentBlocks.length - 1]
    if (last?.type === 'thinking') {
      last.thinking += delta
      return
    }
    contentBlocks.push({
      type: 'thinking',
      thinking: delta,
      signature: '',
    })
  }

  for await (const event of stream) {
    if (event.type === 'message_start') {
      responseId = event.responseId || responseId
      continue
    }

    if (event.type === 'message_stop') {
      const stoppedResponseId = event.message?.responseId ?? event.message?.id
      if (typeof stoppedResponseId === 'string' && stoppedResponseId) {
        responseId = stoppedResponseId
      }
      continue
    }

    if (event.type === 'error') {
      const message = event.error || 'OpenAI stream error'
      if (!hasVisibleOutput && pendingToolCalls.length === 0) {
        throw new Error(message)
      }
      streamError = message
      continue
    }

    if (event.type === 'thinking_delta') {
      if (event.delta) appendThinkingDelta(event.delta)
      continue
    }

    if (event.type === 'text_delta') {
      if (event.delta) {
        emitAssistantStreamUpdate(options, {
          type: 'text_delta',
          delta: event.delta,
        })
        hasVisibleOutput = true
      }
      if (!hasMarkedStreaming) {
        setRequestStatus({ kind: 'streaming' })
        hasMarkedStreaming = true
      }
      const last = contentBlocks[contentBlocks.length - 1]
      if (!last || last.type !== 'text') {
        contentBlocks.push({ type: 'text', text: event.delta, citations: [] })
      } else {
        last.text += event.delta
      }
      continue
    }

    if (event.type === 'tool_request') {
      setRequestStatus({ kind: 'tool', detail: event.tool?.name })
      pendingToolCalls.push(event.tool)
      hasVisibleOutput = true
      continue
    }

    if (event.type === 'usage') {
      // Usage is now in canonical format - just extract the values
      usage.prompt_tokens = event.usage.input
      usage.completion_tokens = event.usage.output
      usage.promptTokens = event.usage.input
      usage.completionTokens = event.usage.output
      usage.totalTokens =
        event.usage.total ?? event.usage.input + event.usage.output
      if (event.usage.reasoning !== undefined) {
        usage.reasoningTokens = event.usage.reasoning
      }
      continue
    }
  }

  for (const toolCall of pendingToolCalls) {
    let toolArgs = {}
    try {
      toolArgs = toolCall.input ? JSON.parse(toolCall.input) : {}
    } catch {}

    contentBlocks.push({
      type: 'tool_use',
      id: toolCall.id,
      name: toolCall.name,
      input: toolArgs,
    })
  }

  const assistantMessage: AiAssistantMessage = {
    type: 'assistant',
    message: {
      id: responseId,
      container: null,
      model: '<responses-stream>',
      role: 'assistant',
      content: contentBlocks,
      stop_details: null,
      stop_reason: streamError ? 'max_tokens' : 'end_turn',
      stop_sequence: null,
      type: 'message',
      usage: createAnthropicUsage({
        input_tokens: usage.prompt_tokens ?? 0,
        output_tokens: usage.completion_tokens ?? 0,
        prompt_tokens: usage.prompt_tokens ?? 0,
        completion_tokens: usage.completion_tokens ?? 0,
        totalTokens:
          usage.totalTokens ??
          (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
        reasoningTokens: usage.reasoningTokens,
      }),
    },
    costUSD: 0,
    durationMs: Date.now() - startTime,
    uuid: randomUUID(),
    responseId,
  }

  return {
    assistantMessage,
    rawResponse: {
      id: responseId,
      content: contentBlocks,
      usage,
      ...(streamError ? { error: streamError } : {}),
    },
  }
}
