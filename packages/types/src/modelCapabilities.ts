// Model capability type definitions for unified API support
export interface ModelCapabilities {
  // API architecture type
  apiArchitecture: {
    primary: 'chat_completions' | 'responses_api'
    fallback?: 'chat_completions' // Responses API models can fallback
  }

  // Parameter mapping
  parameters: {
    maxTokensField: 'max_tokens' | 'max_completion_tokens' | 'max_output_tokens'
    supportsReasoningEffort: boolean
    supportsVerbosity: boolean
    temperatureMode: 'flexible' | 'fixed_one' | 'restricted'
  }

  // Tool calling capabilities
  toolCalling: {
    mode: 'none' | 'function_calling' | 'custom_tools'
    supportsFreeform: boolean
    supportsAllowedTools: boolean
    supportsParallelCalls: boolean
  }

  // State management
  stateManagement: {
    supportsResponseId: boolean
    supportsConversationChaining: boolean
    supportsPreviousResponseId: boolean
  }

  // Streaming support
  streaming: {
    supported: boolean
    includesUsage: boolean
  }
}

export interface ReasoningConfig {
  enable: boolean
  effort: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  summary: 'auto' | 'concise' | 'detailed' | 'none'
}

// Streaming context for reasoning state management
export interface ReasoningStreamingContext {
  thinkOpen: boolean
  thinkClosed: boolean
  sawAnySummary: boolean
  pendingSummaryParagraph: boolean
  thinkingContent?: string
  currentPartIndex?: number
  reasoningPartText?: Map<string, string>
  seenReasoningPartKeys?: Set<string>
  seenToolCallIds?: Set<string>
  responseFunctionCalls?: Map<
    string,
    {
      id?: string
      callId?: string
      name?: string
      arguments: string
    }
  >
}

// Unified request parameters
export interface UnifiedRequestParams {
  messages: any[]
  systemPrompt: string[]
  tools?: any[]
  maxTokens: number
  stream?: boolean
  previousResponseId?: string
  reasoningEffort?:
    'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  reasoning?: ReasoningConfig // Full reasoning config
  verbosity?: 'low' | 'medium' | 'high'
  temperature?: number
  allowedTools?: string[]
  stopSequences?: string[]
}

// Unified response format
export interface UnifiedResponse {
  id: string
  content: string | Array<{ type: string; text?: string; [key: string]: any }>
  toolCalls?: any[]
  usage: {
    promptTokens: number
    completionTokens: number
    reasoningTokens?: number
  }
  responseId?: string // For Responses API state management
}
