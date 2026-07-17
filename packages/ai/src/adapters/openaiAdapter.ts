import { ModelAPIAdapter, StreamingEvent, normalizeTokens } from './base'
import {
  UnifiedRequestParams,
  UnifiedResponse,
  ModelCapabilities,
  ReasoningStreamingContext,
} from '../internal/modelCapabilityTypes'
import type { AiModelProfileLike } from '../internal/runtimeConfig'
import { Tool, getToolDescription } from '@kode/tool-interface/Tool'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { debug as debugLogger } from '../internal/debug'
import { logAiError } from '../internal/runtimeConfig'

// Re-export normalizeTokens and StreamingEvent for subclasses
export { normalizeTokens, type StreamingEvent }

function trimForLog(value: string): string {
  return value.length <= 500 ? value : `${value.slice(0, 500)}...`
}

/**
 * Base adapter for all OpenAI-compatible APIs (Chat Completions and Responses API)
 * Handles common streaming logic, SSE parsing, and usage normalization
 */
export abstract class OpenAIAdapter extends ModelAPIAdapter {
  constructor(capabilities: ModelCapabilities, modelProfile: AiModelProfileLike) {
    super(capabilities, modelProfile)
  }

  /**
   * Unified parseResponse that handles both streaming and non-streaming responses
   */
  async parseResponse(response: any): Promise<UnifiedResponse> {
    // Check if this is a streaming response (has ReadableStream body)
    if (response?.body instanceof ReadableStream) {
      // Use streaming helper for streaming responses
      const { assistantMessage } =
        await this.parseStreamingOpenAIResponse(response)

      return {
        id: assistantMessage.responseId,
        content: assistantMessage.message.content,
        toolCalls: assistantMessage.message.content
          .filter((block: any) => block.type === 'tool_use')
          .map((block: any) => ({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          })),
        usage: this.normalizeUsageForAdapter(assistantMessage.message.usage),
        responseId: assistantMessage.responseId,
      }
    }

    // Process non-streaming response - delegate to subclass
    return this.parseNonStreamingResponse(response)
  }

  /**
   * Common streaming response parser for all OpenAI APIs
   */
  async *parseStreamingResponse(response: any): AsyncGenerator<StreamingEvent> {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    let responseId = response.id || `openai_${Date.now()}`
    let hasStarted = false
    let accumulatedContent = ''

    // Initialize reasoning context for Responses API
    const reasoningContext: ReasoningStreamingContext = {
      thinkOpen: false,
      thinkClosed: false,
      sawAnySummary: false,
      pendingSummaryParagraph: false,
    }

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.trim()) {
            const parsed = this.parseSSEChunk(line)
            if (parsed) {
              // Extract response ID
              const parsedResponseId = this.extractStreamingResponseId(parsed)
              if (parsedResponseId) {
                responseId = parsedResponseId
              }

              const streamError = this.extractStreamingError(parsed)
              if (streamError) {
                yield {
                  type: 'error',
                  error: streamError,
                }
                continue
              }

              // Delegate to subclass for specific processing
              yield* this.processStreamingChunk(
                parsed,
                responseId,
                hasStarted,
                accumulatedContent,
                reasoningContext,
              )

              // Update state based on subclass processing
              const stateUpdate = this.updateStreamingState(
                parsed,
                accumulatedContent,
              )
              if (stateUpdate.content) accumulatedContent = stateUpdate.content
              if (stateUpdate.hasStarted) hasStarted = true
            }
          }
        }
      }
    } catch (error) {
      logAiError(error)
      debugLogger.warn('OPENAI_ADAPTER_STREAM_READ_ERROR', {
        error: error instanceof Error ? error.message : String(error),
      })
      yield {
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      reader.releaseLock()
    }

    // Build final response
    const finalContent = accumulatedContent
      ? [{ type: 'text', text: accumulatedContent, citations: [] }]
      : [{ type: 'text', text: '', citations: [] }]

    // Yield final message stop
    yield {
      type: 'message_stop',
      message: {
        id: responseId,
        role: 'assistant',
        content: finalContent,
        responseId,
      },
    }
  }

  /**
   * Parse SSE chunk - common for all OpenAI APIs
   */
  protected parseSSEChunk(line: string): any | null {
    if (line.startsWith('data: ')) {
      const data = line.slice(6).trim()
      if (data === '[DONE]') {
        return null
      }
      if (data) {
        try {
          return JSON.parse(data)
        } catch (error) {
          const trimmedData = trimForLog(data)
          logAiError(error)
          debugLogger.warn('OPENAI_ADAPTER_SSE_PARSE_ERROR', {
            data: trimmedData,
            error: error instanceof Error ? error.message : String(error),
          })
          throw new Error(
            `OpenAI stream emitted malformed JSON: ${trimmedData}`,
          )
        }
      }
    }
    return null
  }

  private extractStreamingResponseId(parsed: any): string | null {
    const responseId = parsed?.response?.id ?? parsed?.id
    return typeof responseId === 'string' && responseId ? responseId : null
  }

  private extractStreamingError(parsed: any): string | null {
    const response = parsed?.response
    const explicitError = parsed?.error ?? response?.error

    if (explicitError) {
      if (typeof explicitError === 'string') return explicitError
      if (typeof explicitError.message === 'string')
        return explicitError.message
      if (typeof explicitError.code === 'string') return explicitError.code
      return 'OpenAI stream error'
    }

    const isFailed =
      parsed?.type === 'response.failed' || response?.status === 'failed'
    if (isFailed) return 'OpenAI response failed'

    const isIncomplete =
      parsed?.type === 'response.incomplete' ||
      response?.status === 'incomplete'
    if (isIncomplete) {
      const details = response?.incomplete_details ?? parsed?.incomplete_details
      if (typeof details?.reason === 'string') {
        return `OpenAI response incomplete: ${details.reason}`
      }
      return 'OpenAI response incomplete'
    }

    return null
  }

  /**
   * Common helper for processing text deltas
   */
  protected handleTextDelta(
    delta: string,
    responseId: string,
    hasStarted: boolean,
  ): StreamingEvent[] {
    const events: StreamingEvent[] = []

    if (!hasStarted && delta) {
      events.push({
        type: 'message_start',
        message: {
          role: 'assistant',
          content: [],
        },
        responseId,
      })
    }

    if (delta) {
      events.push({
        type: 'text_delta',
        delta,
        responseId,
      })
    }

    return events
  }

  /**
   * Common usage normalization
   */
  protected normalizeUsageForAdapter(usage?: any) {
    if (!usage) {
      return {
        input_tokens: 0,
        output_tokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        reasoningTokens: 0,
      }
    }

    const inputTokens =
      usage.input_tokens ?? usage.prompt_tokens ?? usage.promptTokens ?? 0
    const outputTokens =
      usage.output_tokens ??
      usage.completion_tokens ??
      usage.completionTokens ??
      0

    return {
      ...usage,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      totalTokens: usage.totalTokens ?? inputTokens + outputTokens,
      reasoningTokens: usage.reasoningTokens ?? 0,
    }
  }

  /**
   * Abstract methods that subclasses must implement
   */
  protected abstract processStreamingChunk(
    parsed: any,
    responseId: string,
    hasStarted: boolean,
    accumulatedContent: string,
    reasoningContext?: ReasoningStreamingContext,
  ): AsyncGenerator<StreamingEvent>

  protected abstract updateStreamingState(
    parsed: any,
    accumulatedContent: string,
  ): { content?: string; hasStarted?: boolean }

  protected abstract parseNonStreamingResponse(response: any): UnifiedResponse

  protected abstract parseStreamingOpenAIResponse(
    response: any,
  ): Promise<{ assistantMessage: any; rawResponse: any }>

  /**
   * Common tool building logic
   */
  public buildTools(tools: Tool[]): any[] {
    return tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: getToolDescription(tool),
        parameters: zodToJsonSchema(tool.inputSchema),
      },
    }))
  }
}
