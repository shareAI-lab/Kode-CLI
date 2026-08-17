import { OpenAIAdapter, StreamingEvent, normalizeTokens } from './openaiAdapter'
import {
  UnifiedRequestParams,
  UnifiedResponse,
  ReasoningStreamingContext,
} from '../internal/modelCapabilityTypes'
import { randomUUID } from 'crypto'
import { Tool, getToolDescription } from '@kode/tool-interface/Tool'
import { toInputJsonSchema } from '@kode/tool-interface/jsonSchema'
import { setRequestStatus } from '../internal/requestStatus'
import {
  extractTextAndImageUrls,
  toOpenAIImageUrlParts,
} from '../internal/visionContent'

export class ChatCompletionsAdapter extends OpenAIAdapter {
  private mergeStreamMetadata(previous: string, next: string): string {
    if (!next || previous === next || previous.endsWith(next)) return previous
    if (!previous || next.startsWith(previous)) return next
    return previous + next
  }

  private accumulateToolCallDeltas(
    toolCalls: unknown[],
    reasoningContext?: ReasoningStreamingContext,
  ): void {
    if (!reasoningContext) {
      throw new Error('Chat Completions stream state is unavailable')
    }

    const calls =
      reasoningContext.responseFunctionCalls ??
      (reasoningContext.responseFunctionCalls = new Map())

    for (
      let fallbackIndex = 0;
      fallbackIndex < toolCalls.length;
      fallbackIndex++
    ) {
      const toolCall = toolCalls[fallbackIndex]
      if (
        !toolCall ||
        typeof toolCall !== 'object' ||
        Array.isArray(toolCall)
      ) {
        throw new Error(
          'Chat Completions stream tool_calls entries must be objects',
        )
      }

      const delta = toolCall as Record<string, unknown>
      const rawIndex = delta.index
      if (
        rawIndex !== undefined &&
        (typeof rawIndex !== 'number' ||
          !Number.isInteger(rawIndex) ||
          rawIndex < 0)
      ) {
        throw new Error(
          'Chat Completions stream tool_calls index must be a non-negative integer',
        )
      }
      const index = typeof rawIndex === 'number' ? rawIndex : fallbackIndex
      const key = `chat:${index}`
      const state = calls.get(key) ?? { arguments: '' }

      if (typeof delta.id === 'string') {
        state.id = this.mergeStreamMetadata(state.id ?? '', delta.id)
      }

      const fn = delta.function
      if (fn !== undefined) {
        if (!fn || typeof fn !== 'object' || Array.isArray(fn)) {
          throw new Error(
            'Chat Completions stream tool call function must be an object',
          )
        }
        const functionDelta = fn as Record<string, unknown>
        if (typeof functionDelta.name === 'string') {
          state.name = this.mergeStreamMetadata(
            state.name ?? '',
            functionDelta.name,
          )
        }
        if (typeof functionDelta.arguments === 'string') {
          state.arguments = this.mergeStreamMetadata(
            state.arguments,
            functionDelta.arguments,
          )
        }
      }

      calls.set(key, state)
    }
  }

  private takePendingToolCalls(
    reasoningContext?: ReasoningStreamingContext,
  ): Array<{ id: string; name: string; input: string }> {
    const calls = reasoningContext?.responseFunctionCalls
    if (!calls || calls.size === 0) return []

    const completed: Array<{ id: string; name: string; input: string }> = []
    for (const state of calls.values()) {
      const id = state.id?.trim()
      const name = state.name?.trim()
      if (!id || !name) {
        throw new Error(
          'Chat Completions stream ended with an incomplete tool call',
        )
      }
      completed.push({
        id,
        name,
        input: state.arguments || '{}',
      })
    }
    calls.clear()
    return completed
  }

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
        parameters: tool.inputJSONSchema || toInputJsonSchema(tool.inputSchema),
      },
    }))
  }

  private normalizeToolCalls(value: unknown): any[] {
    if (value === undefined || value === null) return []
    if (!Array.isArray(value)) {
      throw new Error('Chat Completions tool_calls must be an array')
    }

    return value.map((toolCall, index) => {
      if (
        !toolCall ||
        typeof toolCall !== 'object' ||
        Array.isArray(toolCall)
      ) {
        throw new Error(`Chat Completions tool call ${index} must be an object`)
      }

      const call = toolCall as Record<string, unknown>
      const callType = typeof call.type === 'string' ? call.type : 'function'
      if (callType !== 'function') {
        throw new Error(
          `Chat Completions tool call ${index} has unsupported type ${callType}`,
        )
      }

      const id = typeof call.id === 'string' ? call.id.trim() : ''
      const fn = call.function
      if (!fn || typeof fn !== 'object' || Array.isArray(fn)) {
        throw new Error(
          `Chat Completions tool call ${index} is missing its function`,
        )
      }
      const functionCall = fn as Record<string, unknown>
      const name =
        typeof functionCall.name === 'string' ? functionCall.name.trim() : ''
      const rawArguments =
        functionCall.arguments === undefined ||
        functionCall.arguments === null ||
        functionCall.arguments === ''
          ? '{}'
          : functionCall.arguments
      if (!id || !name || typeof rawArguments !== 'string') {
        throw new Error(`Chat Completions tool call ${index} is incomplete`)
      }

      try {
        const parsed = JSON.parse(rawArguments)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('tool arguments must be a JSON object')
        }
      } catch (error) {
        throw new Error(
          `Tool call ${name} has invalid JSON arguments: ${error instanceof Error ? error.message : String(error)}`,
        )
      }

      return {
        id,
        type: 'function',
        function: { name, arguments: rawArguments },
      }
    })
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
    const toolCalls = this.normalizeToolCalls(message.tool_calls)

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
        const newTextDelta = this.mergeStreamMetadata(
          accumulatedContent,
          fullDelta,
        ).slice(accumulatedContent.length)
        if (newTextDelta) {
          const textEvents = this.handleTextDelta(
            newTextDelta,
            responseId,
            hasStarted,
          )
          for (const event of textEvents) {
            yield event
          }
        }
      }
    }

    // Handle tool calls (Chat Completions format)
    const toolCallDeltas = choice?.delta?.tool_calls
    if (toolCallDeltas !== undefined && toolCallDeltas !== null) {
      if (!Array.isArray(toolCallDeltas)) {
        throw new Error(
          'Chat Completions stream tool_calls delta must be an array',
        )
      }
      this.accumulateToolCallDeltas(toolCallDeltas, reasoningContext)
    }

    if (choice?.finish_reason != null) {
      for (const tool of this.takePendingToolCalls(reasoningContext)) {
        yield { type: 'tool_request', tool }
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

  protected async *finalizeStreamingResponse(
    reasoningContext: ReasoningStreamingContext,
  ): AsyncGenerator<StreamingEvent> {
    for (const tool of this.takePendingToolCalls(reasoningContext)) {
      yield { type: 'tool_request', tool }
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
        state.content = this.mergeStreamMetadata(accumulatedContent, fullDelta)
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

        if (event.type === 'error') {
          throw new Error(event.error)
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
        const parsed = toolCall.input ? JSON.parse(toolCall.input) : {}
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('tool arguments must be a JSON object')
        }
        toolArgs = parsed
      } catch (error) {
        throw new Error(
          `Tool call ${toolCall.name || toolCall.id || '<unknown>'} has invalid JSON arguments: ${error instanceof Error ? error.message : String(error)}`,
        )
      }

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
