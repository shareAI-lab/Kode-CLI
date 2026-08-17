import type {
  Message as APIAssistantMessage,
  MessageParam,
} from '@anthropic-ai/sdk/resources/index.mjs'

import type {
  AssistantMessage as CoreAssistantMessage,
  AssistantApiMessage as CoreAssistantApiMessage,
  UserMessage as CoreUserMessage,
} from '#core/query'
import type { UUID } from 'crypto'
import type { CanUseToolFn as InterfaceCanUseToolFn } from '@kode/tool-interface/canUseTool'
import type { Tool, ToolUseContext } from '@kode/tool-interface/Tool'
import type { ToolPermissionContext } from '@kode/tool-interface/permissions'
import type {
  AnthropicUsage,
  ToolUseLikeBlockParam,
} from '@kode/protocol/anthropic'
import type { FullToolUseResult } from '../messages/create'
import type { NormalizedMessage } from '../messages/normalize'

// Extended ToolUseContext for query functions.
export interface ExtendedToolUseContext extends ToolUseContext {
  abortController: AbortController
  /**
   * Dynamic calls from an external runtime finish inside its active model
   * request. Retain their normal Kode transcript messages until the pipeline
   * can yield them to the active UI/session.
   */
  externalToolMessages?: Message[]
  /**
   * Internal counter for the number of model calls ("turns") executed in the current run.
   * Used for non-interactive `--max-turns` enforcement and SDK `num_turns` reporting.
   */
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
    model?: string | import('#config').ModelPointerType
    toolPermissionContext?: ToolPermissionContext
    /**
     * When true, the current execution context cannot show interactive permission prompts.
     * Any permission decision that would normally prompt should be auto-denied.
     */
    shouldAvoidPermissionPrompts?: boolean
    /**
     * When false, suppress legacy-compatible session persistence (.jsonl under config/projects).
     */
    persistSession?: boolean
    automationKind?: 'goal' | 'scheduled_loop'
    /**
     * Optional callback to get custom system prompt additions (e.g., output style).
     * Only called for the main agent.
     */
    getCustomSystemPromptAdditions?: () => string[]
    requestToolUsePermission?: NonNullable<
      ToolUseContext['options']
    >['requestToolUsePermission']
    executeExternalToolCall?: NonNullable<
      ToolUseContext['options']
    >['executeExternalToolCall']
    externalToolCallCount?: number
  }
  readFileTimestamps: { [filename: string]: number }
  setToolJSX: (jsx: any) => void
  requestId?: string
}

export type Response = { costUSD: number; response: string }

export type UserMessage = CoreUserMessage
export type AssistantApiMessage = CoreAssistantApiMessage
export type AssistantMessage = CoreAssistantMessage

export type BinaryFeedbackResult =
  | { message: AssistantMessage | null; shouldSkipPermissionCheck: false }
  | { message: AssistantMessage; shouldSkipPermissionCheck: true }

export type EngineCanUseToolFn = InterfaceCanUseToolFn<
  AssistantMessage,
  ToolUseContext
>

export type ProgressMessage = {
  content: AssistantMessage
  normalizedMessages: NormalizedMessage[]
  siblingToolUseIDs: Set<string>
  tools: Tool[]
  toolUseID: string
  type: 'progress'
  uuid: UUID
}

// Each array item is either a single message or a message-and-response pair
export type Message = UserMessage | AssistantMessage | ProgressMessage

type ToolUseLikeBlock = ToolUseLikeBlockParam

export function isToolUseLikeBlock(block: any): block is ToolUseLikeBlock {
  return (
    block &&
    typeof block === 'object' &&
    (block.type === 'tool_use' ||
      block.type === 'server_tool_use' ||
      block.type === 'mcp_tool_use')
  )
}

export const __isToolUseLikeBlockForTests = isToolUseLikeBlock
