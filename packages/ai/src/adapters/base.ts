import {
  ModelCapabilities,
  UnifiedRequestParams,
  UnifiedResponse,
} from '../internal/modelCapabilityTypes'
import type { AiModelProfileLike } from '../internal/runtimeConfig'
import { Tool } from '@kode/tool-interface/Tool'
import type { AssistantStreamUpdateOptions } from '@kode/tool-interface/assistantStreamUpdate'

// Canonical token representation - normalize once at the boundary
interface TokenUsage {
  input: number
  output: number
  total?: number
  reasoning?: number
}

// Streaming event types for async generator streaming
export type StreamingEvent =
  | { type: 'message_start'; message: any; responseId: string }
  | { type: 'thinking_delta'; delta: string; responseId: string }
  | { type: 'text_delta'; delta: string; responseId: string }
  | { type: 'tool_request'; tool: any }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'message_stop'; message: any }
  | { type: 'error'; error: string }

// Normalize API-specific token names to canonical representation - do this ONCE at the boundary
function normalizeTokens(apiResponse: any): TokenUsage {
  // Validate input to prevent runtime errors
  if (!apiResponse || typeof apiResponse !== 'object') {
    return { input: 0, output: 0 }
  }

  const input =
    Number(
      apiResponse.prompt_tokens ??
        apiResponse.input_tokens ??
        apiResponse.promptTokens,
    ) || 0
  const output =
    Number(
      apiResponse.completion_tokens ??
        apiResponse.output_tokens ??
        apiResponse.completionTokens,
    ) || 0
  const total =
    Number(apiResponse.total_tokens ?? apiResponse.totalTokens) || undefined
  const reasoning =
    Number(apiResponse.reasoning_tokens ?? apiResponse.reasoningTokens) ||
    undefined

  return {
    input,
    output,
    total: total && total > 0 ? total : undefined,
    reasoning: reasoning && reasoning > 0 ? reasoning : undefined,
  }
}

export { type TokenUsage, normalizeTokens }

export abstract class ModelAPIAdapter {
  protected cumulativeUsage: TokenUsage = { input: 0, output: 0 }

  constructor(
    protected capabilities: ModelCapabilities,
    protected modelProfile: AiModelProfileLike,
  ) {}

  // Subclasses must implement these methods
  abstract createRequest(params: UnifiedRequestParams): any
  abstract parseResponse(
    response: any,
    options?: AssistantStreamUpdateOptions,
  ): Promise<UnifiedResponse>
  abstract buildTools(tools: Tool[]): any

  // Optional: subclasses can implement streaming for real-time updates
  // Default implementation yields no events (not supported)
  async *parseStreamingResponse?(
    response: any,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamingEvent> {
    return
  }

  // Reset cumulative usage for new requests
  protected resetCumulativeUsage(): void {
    this.cumulativeUsage = { input: 0, output: 0 }
  }

  // Safely update cumulative usage
  protected updateCumulativeUsage(usage: TokenUsage): void {
    this.cumulativeUsage.input += usage.input
    this.cumulativeUsage.output += usage.output
    if (usage.total) {
      this.cumulativeUsage.total =
        (this.cumulativeUsage.total || 0) + usage.total
    }
    if (usage.reasoning) {
      this.cumulativeUsage.reasoning =
        (this.cumulativeUsage.reasoning || 0) + usage.reasoning
    }
  }

  // Shared utility methods
  protected getMaxTokensParam(): string {
    return this.capabilities.parameters.maxTokensField
  }

  protected getTemperature(): number {
    if (this.capabilities.parameters.temperatureMode === 'fixed_one') {
      return 1
    }
    if (this.capabilities.parameters.temperatureMode === 'restricted') {
      return Math.min(1, 0.7)
    }
    return 0.7
  }

  protected shouldIncludeReasoningEffort(): boolean {
    return this.capabilities.parameters.supportsReasoningEffort
  }

  protected shouldIncludeVerbosity(): boolean {
    return this.capabilities.parameters.supportsVerbosity
  }
}
