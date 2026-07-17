import { OpenAIAdapter, StreamingEvent, normalizeTokens } from './openaiAdapter'
import {
  UnifiedRequestParams,
  UnifiedResponse,
  ReasoningStreamingContext,
} from '../internal/modelCapabilityTypes'
import { randomUUID } from 'crypto'
import { Tool, getToolDescription } from '@kode/tool-interface/Tool'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { setRequestStatus } from '../internal/requestStatus'
import {
  extractTextAndImageUrls,
  toOpenAIImageUrlParts,
} from '../internal/visionContent'

export class ChatCompletionsAdapter extends OpenAIAdapter {
  createRequest(params: UnifiedRequestParams): any {
    const { messages, systemPrompt, tools, maxTokens, stream } = params

    // Build complete message list (including system prompts)
    const fullMessages = this.buildMessages(systemPrompt, messages)

    // Build request
    const request: any = {
      model: this.modelProfile.modelName,
      messages: fullMessages,
      [this.getMaxTokensParam()]: maxTokens,
      temperature: this.getTemperature(),
    }

    // Add tools
    if (tools && tools.length > 0) {
      request.tools = this.buildTools(tools)
      if (this.capabilities.toolCalling.mode !== 'none') {
        request.tool_choice = 'auto'
      }
    }

    // Add reasoning effort using model capabilities
    if (
      this.capabilities.parameters.supportsReasoningEffort &&
      params.reasoningEffort
    ) {
      request.reasoning_effort = params.reasoningEffort // Chat Completions format
    }

    // Add verbosity using model capabilities
    if (this.capabilities.parameters.supportsVerbosity && params.verbosity) {
      request.verbosity = params.verbosity // Chat Completions format
    }

    // Add streaming options using model capabilities
    if (stream && this.capabilities.streaming.supported) {
      request.stream = true
      if (this.capabilities.streaming.includesUsage) {
        request.stream_options = {
          include_usage: true,
        }
      }
    }

    // Apply model-specific constraints based on capabilities
    if (this.capabilities.parameters.temperatureMode === 'fixed_one') {
      // Models like O1 that don't support temperature
      delete request.temperature
    }

    if (!this.capabilities.streaming.supported) {
      // Models that don't support streaming
      delete request.stream
      delete request.stream_options
    }

    return request
  }

  buildTools(tools: Tool[]): any[] {
    // Use tool calling capabilities from model configuration
    return tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: getToolDescription(tool),
        parameters: tool.inputJSONSchema || zodToJsonSchema(tool.inputSchema),
      },
    }))
  }

  protected parseNonStreamingResponse(response: any): UnifiedResponse {
    // Validate response structure
    if (!response || typeof response !== 'object') {
      throw new Error('Invalid response: response must be an object')
    }

    const choice = response.choices?.[0]
    if (!choice) {
      throw new Error('Invalid response: no choices found in response')
    }

    // Extract message content safely
    const message = choice.message || {}
    const content = typeof message.content === 'string' ? message.content : ''
    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls
      : []

    // Extract usage safely
    const usage = response.usage || {}
    const promptTokens = Number(usage.prompt_tokens) || 0
    const completionTokens = Number(usage.completion_tokens) || 0

    return {
      id: response.id || `chatcmpl_${Date.now()}`,
      content,
      toolCalls,
      usage: {
        promptTokens,
        completionTokens,
      },
    }
  }

  private buildMessages(systemPrompt: string[], messages: any[]): any[] {
    // Merge system prompts and messages
    const systemMessages = systemPrompt.map(prompt => ({
      role: 'system',
      content: prompt,
    }))

    // Normalize tool messages (logic from original openai.ts:527-550)
    const normalizedMessages = this.normalizeToolMessages(messages)

    return [...systemMessages, ...normalizedMessages]
  }

  private normalizeToolMessages(messages: any[]): any[] {
    if (!Array.isArray(messages)) {
      return []
    }

    const normalized: any[] = []

    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') {
        normalized.push(msg)
        continue
      }

      if (msg.role === 'tool') {
        const { text, imageUrls } = extractTextAndImageUrls(msg.content)
        normalized.push({
          ...msg,
          content:
            text ||
            (imageUrls.length > 0
              ? '(image output attached in following message)'
              : '(empty content)'),
        })

        if (imageUrls.length > 0) {
          normalized.push({
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Image output from tool ${msg.tool_call_id || msg.id || 'unknown'}:`,
              },
              ...toOpenAIImageUrlParts(imageUrls),
            ],
          })
        }
        continue
      }

      normalized.push(msg)
    }

    return normalized
  }

  // Implement abstract method from OpenAIAdapter - Chat Completions specific streaming logic
  protected async *processStreamingChunk(
    parsed: any,
    responseId: string,
    hasStarted: boolean,
    accumulatedContent: string,
    reasoningContext?: ReasoningStreamingContext,
  ): AsyncGenerator<StreamingEvent> {
    // Validate input
    if (!parsed || typeof parsed !== 'object') {
      return
    }

    // Handle content deltas (Chat Completions format)
    const choice = parsed.choices?.[0]
    if (choice?.delta && typeof choice.delta === 'object') {
      const delta =
        typeof choice.delta.content === 'string' ? choice.delta.content : ''
      const reasoningDelta =
        typeof choice.delta.reasoning_content === 'string'
          ? choice.delta.reasoning_content
          : ''
      const fullDelta = delta + reasoningDelta

      if (fullDelta) {
        const textEvents = this.handleTextDelta(
          fullDelta,
          responseId,
          hasStarted,
        )
        for (const event of textEvents) {
          yield event
        }
      }
    }

    // Handle tool calls (Chat Completions format)
    if (choice?.delta?.tool_calls && Array.isArray(choice.delta.tool_calls)) {
      for (const toolCall of choice.delta.tool_calls) {
        if (toolCall && typeof toolCall === 'object') {
          yield {
            type: 'tool_request',
            tool: {
              id: toolCall.id || `tool_${Date.now()}`,
              name: toolCall.function?.name || 'unknown',
              input: toolCall.function?.arguments || '{}',
            },
          }
        }
      }
    }

    // Handle usage information - normalize to canonical structure and track cumulatively
    if (parsed.usage && typeof parsed.usage === 'object') {
      const normalizedUsage = normalizeTokens(parsed.usage)
      this.updateCumulativeUsage(normalizedUsage)
      yield {
        type: 'usage',
        usage: { ...this.cumulativeUsage },
      }
    }
  }

  protected updateStreamingState(
    parsed: any,
    accumulatedContent: string,
  ): { content?: string; hasStarted?: boolean } {
    const state: { content?: string; hasStarted?: boolean } = {}

    // Check if we have content delta
    const choice = parsed.choices?.[0]
    if (choice?.delta) {
      const delta = choice.delta.content || ''
      const reasoningDelta = choice.delta.reasoning_content || ''
      const fullDelta = delta + reasoningDelta

      if (fullDelta) {
        state.content = accumulatedContent + fullDelta
        state.hasStarted = true
      }
    }

    return state
  }

  // Implement abstract method for parsing streaming OpenAI responses
  protected async parseStreamingOpenAIResponse(
    response: any,
    signal?: AbortSignal,
  ): Promise<{ assistantMessage: any; rawResponse: any }> {
    const contentBlocks: any[] = []
    const usage: any = {
      prompt_tokens: 0,
      completion_tokens: 0,
    }

    let responseId = response.id || `chatcmpl_${Date.now()}`
    const pendingToolCalls: any[] = []
    let hasMarkedStreaming = false

    try {
      this.resetCumulativeUsage() // Reset usage for new request

      for await (const event of this.parseStreamingResponse(response)) {
        // Check for abort signal
        if (signal?.aborted) {
          throw new Error('Stream aborted by user')
        }

        if (event.type === 'message_start') {
          responseId = event.responseId || responseId
          continue
        }

        if (event.type === 'text_delta') {
          if (!hasMarkedStreaming) {
            setRequestStatus({ kind: 'streaming' })
            hasMarkedStreaming = true
          }
          const last = contentBlocks[contentBlocks.length - 1]
          if (!last || last.type !== 'text') {
            contentBlocks.push({
              type: 'text',
              text: event.delta,
              citations: [],
            })
          } else {
            last.text += event.delta
          }
          continue
        }

        if (event.type === 'tool_request') {
          setRequestStatus({ kind: 'tool', detail: event.tool?.name })
          pendingToolCalls.push(event.tool)
          continue
        }

        if (event.type === 'usage') {
          // Usage is now in canonical format - just extract the values
          usage.prompt_tokens = event.usage.input
          usage.completion_tokens = event.usage.output
          usage.totalTokens =
            event.usage.total ?? event.usage.input + event.usage.output
          usage.promptTokens = event.usage.input
          usage.completionTokens = event.usage.output
          continue
        }
      }
    } catch (error) {
      if (signal?.aborted) {
        // Return partial response on abort
        const assistantMessage = {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: contentBlocks,
            usage: {
              input_tokens: usage.prompt_tokens ?? 0,
              output_tokens: usage.completion_tokens ?? 0,
              prompt_tokens: usage.prompt_tokens ?? 0,
              completion_tokens: usage.completion_tokens ?? 0,
              totalTokens:
                (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
            },
          },
          costUSD: 0,
          durationMs: Date.now() - Date.now(),
          uuid: randomUUID(),
          responseId,
        }
        return {
          assistantMessage,
          rawResponse: {
            id: responseId,
            content: contentBlocks,
            usage,
            aborted: true,
          },
        }
      }
      throw error // Re-throw other errors
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
    const assistantMessage = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: contentBlocks,
        usage: {
          input_tokens: usage.prompt_tokens ?? 0,
          output_tokens: usage.completion_tokens ?? 0,
          prompt_tokens: usage.prompt_tokens ?? 0,
          completion_tokens: usage.completion_tokens ?? 0,
          totalTokens:
            usage.totalTokens ??
            (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
        },
      },
      costUSD: 0,
      durationMs: Date.now() - Date.now(), // Placeholder
      uuid: randomUUID(),
      responseId,
    }
    return {
      assistantMessage,
      rawResponse: {
        id: responseId,
        content: contentBlocks,
        usage,
      },
    }
  }
  protected normalizeUsageForAdapter(usage?: any) {
    return super.normalizeUsageForAdapter(usage)
  }
}
