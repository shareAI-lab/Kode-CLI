import type { CanUseToolFn } from '#core/permissions/canUseTool'
import type {
  AssistantMessage,
  BinaryFeedbackResult,
  ExtendedToolUseContext,
  Message as ConversationMessage,
} from '#core/query'
import type { PermissionMode } from '#core/types/PermissionMode'
import type { Tool } from '@kode/tool-interface/Tool'
import type { getKodeAgentSessionForkInfo } from '#protocol/utils/kodeAgentSessionForkInfo'

export type QueryFn = (
  messages: ConversationMessage[],
  systemPrompt: string[],
  context: Record<string, string>,
  canUseTool: CanUseToolFn,
  toolUseContext: ExtendedToolUseContext,
  getBinaryFeedbackResponse?: (
    m1: AssistantMessage,
    m2: AssistantMessage,
  ) => Promise<BinaryFeedbackResult>,
) => AsyncGenerator<ConversationMessage, void>

export type TaskToolQueryOptions = ExtendedToolUseContext['options'] & {
  permissionMode: PermissionMode
  tools: Tool[]
}

export type PreparedTaskToolRun = {
  queryFn: QueryFn
  agentId: string
  effectivePrompt: string
  systemPrompt: string[]
  context: Record<string, string>
  messagesForQuery: ConversationMessage[]
  transcriptMessages: ConversationMessage[]
  queryOptions: TaskToolQueryOptions
  messageLogName: string
  forkNumber: number
  abortController: AbortController
  readFileTimestamps: Record<string, number>
  startTime: number
  cwd: string
  originalCwd: string
  sessionId: string
  sessionForkInfo: ReturnType<typeof getKodeAgentSessionForkInfo>
}
