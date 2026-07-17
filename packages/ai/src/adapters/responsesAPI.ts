import { OpenAIAdapter, StreamingEvent, normalizeTokens } from './openaiAdapter'
import {
  UnifiedRequestParams,
  UnifiedResponse,
  ReasoningStreamingContext,
} from '../internal/modelCapabilityTypes'
import { Tool, getToolDescription } from '@kode/tool-interface/Tool'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { processResponsesStream } from './responsesStreaming'
import { debug as debugLogger } from '../internal/debug'
import { logAiError } from '../internal/runtimeConfig'
import {
  buildInstructions,
  convertMessagesToInput,
} from './responsesAPI/messageInput'
import { parseNonStreamingResponse as parseResponsesApiNonStreamingResponse } from './responsesAPI/nonStreaming'
import type { AssistantStreamUpdateOptions } from '@kode/tool-interface/assistantStreamUpdate'

type StreamingFunctionCallState = {
  id?: string
  callId?: string
  name?: string
  arguments: string
}

export class ResponsesAPIAdapter extends OpenAIAdapter {
  createRequest(params: UnifiedRequestParams): any {
    const {
      messages,
      systemPrompt,
      tools,
      maxTokens,
      reasoningEffort,
      stopSequences,
    } = params

    // Build base request
    const request: any = {
      model: this.modelProfile.modelName,
      input: convertMessagesToInput(messages),
      instructions: buildInstructions(systemPrompt),
    }

    // Add token limit using model capabilities
    const maxTokensField = this.getMaxTokensParam()
    request[maxTokensField] = maxTokens

    if (stopSequences && stopSequences.length > 0) {
      request.stop = stopSequences
    }

    // Add streaming support using model capabilities
    request.stream =
      params.stream !== false && this.capabilities.streaming.supported

    // Add temperature using model capabilities
    const temperature = this.getTemperature()
    if (temperature !== undefined) {
      request.temperature = temperature
    }

    // Add reasoning control using model capabilities
    const include: string[] = []
    if (
      this.capabilities.parameters.supportsReasoningEffort &&
      (this.shouldIncludeReasoningEffort() || reasoningEffort)
    ) {
      include.push('reasoning.encrypted_content')
      request.reasoning = {
        effort:
          reasoningEffort || this.modelProfile.reasoningEffort || 'medium',
      }
    }

    // Add verbosity control using model capabilities
    if (
      this.capabilities.parameters.supportsVerbosity &&
      this.shouldIncludeVerbosity()
    ) {
      // Determine default verbosity based on model name if not provided
      let defaultVerbosity: 'low' | 'medium' | 'high' = 'medium'
      if (params.verbosity) {
        defaultVerbosity = params.verbosity
      } else {
        const modelNameLower = this.modelProfile.modelName.toLowerCase()
        if (modelNameLower.includes('high')) {
          defaultVerbosity = 'high'
        } else if (modelNameLower.includes('low')) {
          defaultVerbosity = 'low'
        }
        // Default to 'medium' for all other cases
      }

      request.text = {
        verbosity: defaultVerbosity,
      }
    }

    // Add tools
    if (tools && tools.length > 0) {
      request.tools = this.buildTools(tools)
    }

    // Add tool choice using model capabilities
    request.tool_choice = 'auto'

    // Add parallel tool calls flag using model capabilities
    if (this.capabilities.toolCalling.supportsParallelCalls) {
      request.parallel_tool_calls = true
    }

    // Add store flag
    request.store = false

    // Add state management
    if (
      params.previousResponseId &&
      this.capabilities.stateManagement.supportsPreviousResponseId
    ) {
      request.previous_response_id = params.previousResponseId
    }

    // Add include array for reasoning and other content
    if (include.length > 0) {
      request.include = include
    }

    return request
  }

  buildTools(tools: Tool[]): any[] {
    // Use flat function schema shape (Responses API)
    const isPlainObject = (obj: unknown): obj is Record<string, unknown> => {
      return obj !== null && typeof obj === 'object' && !Array.isArray(obj)
    }

    return tools.map(tool => {
      // Prefer pre-built JSON schema if available
      let parameters: Record<string, unknown> | undefined = tool.inputJSONSchema

      // Otherwise, check if inputSchema is already a JSON schema (not Zod)
      if (!parameters && tool.inputSchema) {
        const inputSchema: unknown = tool.inputSchema
        if (
          isPlainObject(inputSchema) &&
          ('type' in inputSchema || 'properties' in inputSchema)
        ) {
          parameters = inputSchema
        } else {
          // Try to convert Zod schema
          try {
            const converted: unknown = zodToJsonSchema(tool.inputSchema)
            parameters =
              isPlainObject(converted) &&
              ('type' in converted || 'properties' in converted)
                ? converted
                : { type: 'object', properties: {} }
          } catch (error) {
            logAiError(error)
            debugLogger.warn('RESPONSES_API_TOOL_SCHEMA_CONVERSION_FAILED', {
              toolName: tool.name,
              error: error instanceof Error ? error.message : String(error),
            })
            // Use minimal schema as fallback
            parameters = { type: 'object', properties: {} }
          }
        }
      }

      return {
        type: 'function',
        name: tool.name,
        description: getToolDescription(tool),
        parameters: parameters ?? { type: 'object', properties: {} },
      }
    })
  }

  private getFunctionCallKey(parsed: any, item?: any): string | null {
    const outputIndex = parsed.output_index
    if (typeof outputIndex === 'number' || typeof outputIndex === 'string') {
      return `output:${outputIndex}`
    }

    const itemId = parsed.item_id || item?.id || item?.call_id
    if (typeof itemId === 'string' && itemId) {
      return `item:${itemId}`
    }

    return null
  }

  private getFunctionCallMap(
    reasoningContext?: ReasoningStreamingContext,
  ): Map<string, StreamingFunctionCallState> | undefined {
    if (!reasoningContext) return undefined
    if (!reasoningContext.responseFunctionCalls) {
      reasoningContext.responseFunctionCalls = new Map()
    }
    return reasoningContext.responseFunctionCalls
  }

  private updateFunctionCallStateFromItem(
    state: StreamingFunctionCallState,
    item: any,
  ): StreamingFunctionCallState {
    if (typeof item?.id === 'string') state.id = item.id
    if (typeof item?.call_id === 'string') state.callId = item.call_id
    if (typeof item?.name === 'string') state.name = item.name
    if (typeof item?.arguments === 'string') state.arguments = item.arguments
    return state
  }

  private toFunctionCallTool(state: StreamingFunctionCallState): {
    id: string
    name: string
    input: string
  } | null {
    const callId = state.callId || state.id
    if (
      typeof callId !== 'string' ||
      typeof state.name !== 'string' ||
      typeof state.arguments !== 'string'
    ) {
      return null
    }

    return {
      id: callId,
      name: state.name,
      input: state.arguments,
    }
  }

  private getFunctionCallFromStreamingEvent(
    parsed: any,
    reasoningContext?: ReasoningStreamingContext,
  ): {
    id: string
    name: string
    input: string
  } | null {
    const map = this.getFunctionCallMap(reasoningContext)

    if (parsed.type === 'response.output_item.added') {
      const item = parsed.item || {}
      if (item.type !== 'function_call') return null

      const key = this.getFunctionCallKey(parsed, item)
      if (!key || !map) return null

      const state = map.get(key) ?? { arguments: '' }
      map.set(key, this.updateFunctionCallStateFromItem(state, item))
      return null
    }

    if (parsed.type === 'response.function_call_arguments.delta') {
      const key = this.getFunctionCallKey(parsed)
      if (!key || !map || typeof parsed.delta !== 'string') return null

      const state = map.get(key) ?? { arguments: '' }
      state.arguments += parsed.delta
      map.set(key, state)
      return null
    }

    if (parsed.type === 'response.function_call_arguments.done') {
      const item = parsed.item || {}
      const key = this.getFunctionCallKey(parsed, item)
      const state =
        (key && map?.get(key)) ??
        (item.type === 'function_call' ? { arguments: '' } : null)

      if (!state) return null

      if (item.type === 'function_call') {
        this.updateFunctionCallStateFromItem(state, item)
      }
      if (typeof parsed.arguments === 'string') {
        state.arguments = parsed.arguments
      }
      if (key && map) map.set(key, state)

      return this.toFunctionCallTool(state)
    }

    const item =
      parsed.type === 'response.output_item.done' ? parsed.item : null

    if (!item || item.type !== 'function_call') {
      return null
    }

    const key = this.getFunctionCallKey(parsed, item)
    const state =
      (key && map?.get(key)) ??
      ({ arguments: '' } satisfies StreamingFunctionCallState)

    this.updateFunctionCallStateFromItem(state, item)
    if (key && map) map.set(key, state)

    return this.toFunctionCallTool(state)
  }

  // Override parseResponse to handle Response API directly without double conversion
  async parseResponse(
    response: any,
    options?: AssistantStreamUpdateOptions,
  ): Promise<UnifiedResponse> {
    // Check if this is a streaming response (has ReadableStream body)
    if (response?.body instanceof ReadableStream) {
      // Handle streaming directly - don't go through OpenAIAdapter conversion
      const { assistantMessage } = await processResponsesStream(
        this.parseStreamingResponse(response),
        Date.now(),
        response.id ?? `resp_${Date.now()}`,
        options,
      )

      // LINUX WAY: ONE representation only - tool_use blocks in content
      // NO toolCalls array when we have tool_use blocks
      const hasToolUseBlocks = assistantMessage.message.content.some(
        (block: any) => block.type === 'tool_use',
      )

      return {
        id: assistantMessage.responseId,
        content: assistantMessage.message.content,
        toolCalls: hasToolUseBlocks ? [] : [],
        usage: this.normalizeUsageForAdapter(assistantMessage.message.usage),
        responseId: assistantMessage.responseId,
      }
    }

    // Process non-streaming response - delegate to existing method
    return this.parseNonStreamingResponse(response)
  }

  // Implement abstract method from OpenAIAdapter
  protected parseNonStreamingResponse(response: any): UnifiedResponse {
    return parseResponsesApiNonStreamingResponse(response)
  }

  // Implement abstract method from OpenAIAdapter - Responses API specific streaming logic
  protected async *processStreamingChunk(
    parsed: any,
    responseId: string,
    hasStarted: boolean,
    accumulatedContent: string,
    reasoningContext?: ReasoningStreamingContext,
  ): AsyncGenerator<StreamingEvent> {
    // Handle reasoning summary part events
    if (parsed.type === 'response.reasoning_summary_part.added') {
      const partIndex = parsed.summary_index || 0

      // Initialize reasoning state if not already done
      if (!reasoningContext?.thinkingContent) {
        reasoningContext!.thinkingContent = ''
        reasoningContext!.currentPartIndex = -1
      }

      reasoningContext!.currentPartIndex = partIndex

      // If this is not the first part and we have content, add newline separator
      if (partIndex > 0 && reasoningContext!.thinkingContent) {
        reasoningContext!.thinkingContent += '\n\n'

        // Keep provider reasoning separate from user-facing output.
        yield {
          type: 'thinking_delta',
          delta: '\n\n',
          responseId,
        }
      }

      return
    }

    // Handle reasoning summary text delta
    if (parsed.type === 'response.reasoning_summary_text.delta') {
      const delta = parsed.delta || ''

      if (delta && reasoningContext) {
        // Accumulate thinking content
        reasoningContext.thinkingContent += delta

        // Do not turn reasoning into user-facing text. A thinking-only
        // response must remain detectable by the turn recovery pipeline.
        yield {
          type: 'thinking_delta',
          delta,
          responseId,
        }
      }

      return
    }

    // Handle reasoning text delta
    if (parsed.type === 'response.reasoning_text.delta') {
      const delta = parsed.delta || ''

      if (delta && reasoningContext) {
        // Accumulate thinking content
        reasoningContext.thinkingContent += delta

        // Do not turn reasoning into user-facing text. A thinking-only
        // response must remain detectable by the turn recovery pipeline.
        yield {
          type: 'thinking_delta',
          delta,
          responseId,
        }
      }

      return
    }

    // Handle text content deltas (Responses API format)
    if (parsed.type === 'response.output_text.delta') {
      const delta = parsed.delta || ''
      if (delta) {
        const textEvents = this.handleTextDelta(delta, responseId, hasStarted)
        for (const event of textEvents) {
          yield event
        }
      }
    }

    // Handle tool calls (Responses API streaming format)
    const functionCall = this.getFunctionCallFromStreamingEvent(
      parsed,
      reasoningContext,
    )
    if (functionCall) {
      const seenToolCallIds =
        reasoningContext?.seenToolCallIds ??
        (reasoningContext
          ? (reasoningContext.seenToolCallIds = new Set<string>())
          : undefined)

      if (!seenToolCallIds?.has(functionCall.id)) {
        seenToolCallIds?.add(functionCall.id)
        yield {
          type: 'tool_request',
          tool: functionCall,
        }
      }
    }

    // Handle usage information - normalize to canonical structure
    const usage = parsed.usage ?? parsed.response?.usage
    if (usage) {
      const normalizedUsage = normalizeTokens(usage)

      // Add reasoning tokens if available in Responses API format
      if (usage.output_tokens_details?.reasoning_tokens) {
        normalizedUsage.reasoning = usage.output_tokens_details.reasoning_tokens
      }

      yield {
        type: 'usage',
        usage: normalizedUsage,
      }
    }
  }

  protected updateStreamingState(
    parsed: any,
    accumulatedContent: string,
  ): { content?: string; hasStarted?: boolean } {
    const state: { content?: string; hasStarted?: boolean } = {}

    // Check if we have content delta
    if (parsed.type === 'response.output_text.delta' && parsed.delta) {
      state.content = accumulatedContent + parsed.delta
      state.hasStarted = true
    }

    return state
  }

  // parseStreamingResponse and parseSSEChunk are now handled by the base OpenAIAdapter class

  // Implement abstract method for parsing streaming OpenAI responses
  protected async parseStreamingOpenAIResponse(
    response: any,
    options?: AssistantStreamUpdateOptions,
  ): Promise<{ assistantMessage: any; rawResponse: any }> {
    // Delegate to the processResponsesStream helper for consistency
    const { processResponsesStream } = await import('./responsesStreaming')

    return await processResponsesStream(
      this.parseStreamingResponse(response),
      Date.now(),
      response.id ?? `resp_${Date.now()}`,
      options,
    )
  }

  // Implement abstract method for usage normalization
  protected normalizeUsageForAdapter(usage?: any) {
    // Call the base implementation with Responses API specific defaults
    const baseUsage = super.normalizeUsageForAdapter(usage)

    // Add any Responses API specific usage fields
    return {
      ...baseUsage,
      reasoningTokens: usage?.output_tokens_details?.reasoning_tokens ?? 0,
    }
  }
}
