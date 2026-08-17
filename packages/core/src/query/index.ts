import type {
  ImageBlockParam,
  Message as APIAssistantMessage,
  MessageParam,
  TextBlockParam,
  ToolResultBlockParam,
  ToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import type { UUID } from 'crypto'

import type { ModelPointerType } from '#config'
import type { CanUseToolFn as InterfaceCanUseToolFn } from '@kode/tool-interface/canUseTool'
import type {
  Tool,
  ToolResultMetadata,
  ToolUseContext,
} from '@kode/tool-interface/Tool'
import type { ToolPermissionContext } from '@kode/tool-interface/permissions'
import type {
  AnthropicUsage,
  ToolUseLikeBlockParam,
} from '@kode/protocol/anthropic'

export type FullToolUseResult = {
  data: unknown
  resultForAssistant: ToolResultBlockParam['content']
  metadata?: ToolResultMetadata
  newMessages?: Message[]
  contextModifier?: { modifyContext: (ctx: any) => any }
}

export interface ExtendedToolUseContext extends ToolUseContext {
  abortController: AbortController
  turnCount?: number
  options: {
    commands: any[]
    forkNumber: number
    messageLogName: string
    tools: Tool[]
    mcpClients?: any[]
    verbose: boolean
    safeMode: boolean
    onStreamEvent?: (event: unknown) => void
    onAssistantStreamUpdate?: NonNullable<
      ToolUseContext['options']
    >['onAssistantStreamUpdate']
    maxBudgetUsd?: number
    maxTurns?: number
    maxThinkingTokens: number
    thinkingMode?: 'auto' | 'enabled' | 'disabled'
    isKodingRequest?: boolean
    commandAllowedTools?: string[]
    lastUserPrompt?: string
    voiceTurn?: boolean
    voiceIntentPrepared?: boolean
    model?: string | ModelPointerType
    toolPermissionContext?: ToolPermissionContext
    shouldAvoidPermissionPrompts?: boolean
    persistSession?: boolean
    getCustomSystemPromptAdditions?: () => string[]
    requestToolUsePermission?: NonNullable<
      ToolUseContext['options']
    >['requestToolUsePermission']
  }
  readFileTimestamps: { [filename: string]: number }
  setToolJSX: (jsx: any) => void
  requestId?: string
}

export type Response = { costUSD: number; response: string }

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
    /** Submitted through the reviewed voice UI. */
    voiceInput?: boolean
    /** Voice turn eligible for best-effort TTS. */
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

export type BinaryFeedbackResult =
  | { message: AssistantMessage | null; shouldSkipPermissionCheck: false }
  | { message: AssistantMessage; shouldSkipPermissionCheck: true }

export type EngineCanUseToolFn = InterfaceCanUseToolFn<
  AssistantMessage,
  ToolUseContext
>

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

export function isToolUseLikeBlock(
  block: unknown,
): block is ToolUseLikeBlockParam {
  return (
    Boolean(block) &&
    typeof block === 'object' &&
    ((block as { type?: unknown }).type === 'tool_use' ||
      (block as { type?: unknown }).type === 'server_tool_use' ||
      (block as { type?: unknown }).type === 'mcp_tool_use')
  )
}

export const __isToolUseLikeBlockForTests = isToolUseLikeBlock

export * from './agentEvents'
