import type { UUID } from 'crypto'

import type {
  ImageBlockParam,
  Message as APIAssistantMessage,
  MessageParam,
  TextBlockParam,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import type { AnthropicUsage } from '@kode/protocol/anthropic'
import type { Tool, ToolResultMetadata } from '@kode/tool-interface/Tool'

export type FullToolUseResult = {
  data: unknown
  resultForAssistant: ToolResultBlockParam['content']
  metadata?: ToolResultMetadata
  newMessages?: Message[]
  contextModifier?: { modifyContext: (ctx: any) => any }
}

export type UserMessage = {
  message: MessageParam
  type: 'user'
  uuid: UUID
  toolUseResult?: FullToolUseResult
  options?: {
    isKodingRequest?: boolean
    kodingContext?: string
    isCustomCommand?: boolean
    commandName?: string
    commandArgs?: string
    requestStatusDetail?: string
    voiceInput?: boolean
    voiceResponse?: boolean
  }
}

export type AssistantApiMessage = Omit<
  Partial<APIAssistantMessage>,
  'content' | 'usage' | 'role' | 'type'
> & {
  id: string
  model: string
  role: 'assistant'
  type: 'message'
  content: any[]
  usage: AnthropicUsage
  stop_reason?: APIAssistantMessage['stop_reason'] | null
  stop_sequence?: string | null
}

export type AssistantMessage = {
  costUSD: number
  durationMs: number
  message: AssistantApiMessage
  type: 'assistant'
  uuid: UUID
  isApiErrorMessage?: boolean
  isMeta?: boolean
  requestId?: string
  responseId?: string
}

type NormalizedUserMessage = {
  message: {
    content: [
      | TextBlockParam
      | ImageBlockParam
      | ToolUseBlockParam
      | ToolResultBlockParam,
    ]
    role: 'user'
  }
  type: 'user'
  uuid: UUID
}

export type NormalizedMessage =
  NormalizedUserMessage | AssistantMessage | ProgressMessage

export type ProgressMessage = {
  content: AssistantMessage
  normalizedMessages: NormalizedMessage[]
  siblingToolUseIDs: Set<string>
  tools: Tool[]
  toolUseID: string
  type: 'progress'
  uuid: UUID
}

export type Message = UserMessage | AssistantMessage | ProgressMessage
