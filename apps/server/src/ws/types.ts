import type { Message } from '@kode/core/query'
import type { ToolUseContext } from '@kode/core/tooling/Tool'
import type { ToolPermissionContext } from '@kode/types/toolPermissionContext'
import type { AgentEvent, DaemonEventMetadata } from '#protocol/agentEvent'

export type DaemonClient = {
  send: (data: string) => void
  data?: Record<string, unknown>
}

export type InflightPermissionDecision = {
  decision: 'allow_once' | 'allow_always' | 'deny'
  updatedInput?: Record<string, unknown> | null
  rejectionMessage?: string | null
}

export type InflightPermissionRequest = {
  owner: DaemonClient | null
  resolve: (value: InflightPermissionDecision) => void
}

export type DaemonTurn = {
  turnId: string
  clientMessageUuid: string
  state: 'running' | 'completed'
  terminalEvent: AgentEvent | null
}

export type DaemonSessionJournalEntry = {
  event: AgentEvent
  metadata: DaemonEventMetadata
}

export type DaemonSession = {
  sessionId: string
  cwd: string
  createdAt: string
  updatedAt: string
  forkedFromSessionId: string | null
  forkRootSessionId: string | null
  clients: Set<DaemonClient>
  messages: Message[]
  readFileTimestamps: Record<string, number>
  responseState: ToolUseContext['responseState']
  toolPermissionContext: ToolPermissionContext
  activeAbortController: AbortController | null
  turnInFlight: boolean
  inflightPermissionRequests: Map<string, InflightPermissionRequest>
  nextSequence: number
  eventJournal: DaemonSessionJournalEntry[]
  turnsByClientMessageUuid: Map<string, DaemonTurn>
}
