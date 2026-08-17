import type { Command } from '#cli-commands'
import type {
  Message as MessageType,
  AssistantMessage,
  BinaryFeedbackResult,
} from '#core/query'
import type { WrappedClient } from '#core/mcp/client'
import type { Tool } from '#core/tooling/Tool'

export type REPLProps = {
  commands: Command[]
  safeMode?: boolean
  debug?: boolean
  disableSlashCommands?: boolean
  systemPromptOverride?: string
  appendSystemPrompt?: string
  initialForkNumber?: number | undefined
  initialPrompt: string | undefined
  messageLogName: string
  shouldShowPromptInput: boolean
  tools: Tool[]
  verbose: boolean | undefined
  initialMessages?: MessageType[]
  mcpClients?: WrappedClient[]
  isDefaultModel?: boolean
  initialUpdateVersion?: string | null
  initialUpdateCommands?: string[] | null
  /**
   * When provided, the REPL mounts immediately with empty tools/commands/MCP
   * clients and rehydrates them as these promises resolve. Queries and the
   * initial prompt are gated until everything is ready.
   */
  toolsPromise?: Promise<Tool[]>
  commandsPromise?: Promise<Command[]>
  mcpClientsPromise?: Promise<WrappedClient[]>
}

export type BinaryFeedbackContext = {
  m1: AssistantMessage
  m2: AssistantMessage
  resolve: (result: BinaryFeedbackResult) => void
}
