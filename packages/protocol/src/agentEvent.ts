import { z } from 'zod'

import type { Session } from './session'
import type { SdkMessage } from './streamJson'

export type PermissionRequestEvent = {
  type: 'permission_request'
  request_id: string
  tool_name: string
  tool_description: string
  input: Record<string, unknown>
}

export type HistoryBeginEvent = {
  type: 'history_begin'
  sessionId: string
}

export type HistoryEndEvent = {
  type: 'history_end'
  sessionId: string
}

export type TurnStateEvent = {
  type: 'turn_state'
  session_id: string
  state: 'idle' | 'running'
}

export type SessionListEvent = {
  type: 'session_list'
  sessions: Session[]
}

/**
 * Daemon-only correlation metadata. It deliberately lives outside the raw
 * stream-json event so CLI print, ACP, and legacy WebSocket clients can keep
 * consuming their existing wire format unchanged.
 */
export type DaemonEventMetadata = {
  sessionId: string
  turnId: string | null
  clientMessageUuid: string | null
  sequence: number
  replayed: boolean
  /** True only when replay establishes a full durable history snapshot. */
  snapshot: boolean
}

export type AgentEvent =
  | SdkMessage
  | PermissionRequestEvent
  | HistoryBeginEvent
  | HistoryEndEvent
  | TurnStateEvent
  | SessionListEvent

/**
 * Opt-in daemon WebSocket projection of an AgentEvent. Raw AgentEvent values
 * remain the compatibility format for legacy clients and non-daemon outputs.
 */
export type DaemonEventEnvelope = {
  type: 'daemon_event'
  event: AgentEvent
  metadata: DaemonEventMetadata
}

export type DaemonWsEvent = AgentEvent | DaemonEventEnvelope

export type NormalizedDaemonWsEvent = {
  event: AgentEvent
  metadata: DaemonEventMetadata | null
}

const ContentBlockSchema = z
  .object({
    type: z.string(),
  })
  .passthrough()

const SystemEventSchema = z
  .object({
    type: z.literal('system'),
    subtype: z.string(),
    session_id: z.string().optional(),
    model: z.string().optional(),
    cwd: z.string().optional(),
    tools: z.array(z.string()).optional(),
    slash_commands: z.array(z.string()).optional(),
    status: z.string().optional(),
    uuid: z.string().optional(),
  })
  .strict()

const UserEventSchema = z
  .object({
    type: z.literal('user'),
    session_id: z.string().optional(),
    uuid: z.string().optional(),
    parent_tool_use_id: z.string().nullable().optional(),
    message: z
      .object({
        role: z.literal('user'),
        content: z.union([z.string(), z.array(ContentBlockSchema)]),
      })
      .strict(),
  })
  .strict()

const AssistantEventSchema = z
  .object({
    type: z.literal('assistant'),
    session_id: z.string().optional(),
    uuid: z.string().optional(),
    parent_tool_use_id: z.string().nullable().optional(),
    message: z
      .object({
        role: z.literal('assistant'),
        content: z.array(ContentBlockSchema),
      })
      .strict(),
  })
  .strict()

const StreamEventSchema = z
  .object({
    type: z.literal('stream_event'),
    event: z.unknown(),
    session_id: z.string(),
    parent_tool_use_id: z.string().nullable().optional(),
    uuid: z.string().optional(),
  })
  .strict()

const ResultEventSchema = z
  .object({
    type: z.literal('result'),
    subtype: z.enum([
      'success',
      'error_during_execution',
      'error_max_turns',
      'error_max_budget_usd',
    ]),
    result: z.string().optional(),
    structured_output: z.record(z.string(), z.unknown()).optional(),
    num_turns: z.number(),
    usage: z.unknown().optional(),
    total_cost_usd: z.number(),
    duration_ms: z.number(),
    duration_api_ms: z.number(),
    is_error: z.boolean(),
    session_id: z.string(),
    uuid: z.string().optional(),
  })
  .strict()

const LogEventSchema = z
  .object({
    type: z.literal('log'),
    log: z
      .object({
        level: z.enum(['debug', 'info', 'warn', 'error']),
        message: z.string(),
      })
      .strict(),
  })
  .strict()

const PermissionRequestEventSchema = z
  .object({
    type: z.literal('permission_request'),
    request_id: z.string(),
    tool_name: z.string(),
    tool_description: z.string(),
    input: z.record(z.string(), z.unknown()),
  })
  .strict()

const HistoryBeginEventSchema = z
  .object({
    type: z.literal('history_begin'),
    sessionId: z.string(),
  })
  .strict()

const HistoryEndEventSchema = z
  .object({
    type: z.literal('history_end'),
    sessionId: z.string(),
  })
  .strict()

const TurnStateEventSchema = z
  .object({
    type: z.literal('turn_state'),
    session_id: z.string(),
    state: z.enum(['idle', 'running']),
  })
  .strict()

const SessionSchema = z
  .object({
    sessionId: z.string(),
    slug: z.string().nullable(),
    customTitle: z.string().nullable(),
    tag: z.string().nullable(),
    summary: z.string().nullable(),
    cwd: z.string().nullable(),
    createdAt: z.string().nullable(),
    modifiedAt: z.string().nullable(),
    forkedFromSessionId: z.string().nullable().optional(),
    forkRootSessionId: z.string().nullable().optional(),
    archivedAt: z.string().nullable().optional(),
    events: z.array(z.lazy(() => AgentEventSchema)).optional(),
  })
  .strict() as unknown as z.ZodType<Session>

const SessionListEventSchema = z
  .object({
    type: z.literal('session_list'),
    sessions: z.array(SessionSchema),
  })
  .strict()

export const DaemonEventMetadataSchema: z.ZodType<DaemonEventMetadata> = z
  .object({
    sessionId: z.string().min(1),
    turnId: z.string().min(1).nullable(),
    clientMessageUuid: z.string().uuid().nullable(),
    sequence: z.number().int().nonnegative(),
    replayed: z.boolean(),
    // Older capability producers did not carry this discriminator. Treat
    // them as deltas so a new client does not reset a cursor unnecessarily.
    snapshot: z.boolean().default(false),
  })
  .strict() as unknown as z.ZodType<DaemonEventMetadata>

export const AgentEventSchema: z.ZodType<AgentEvent> = z.discriminatedUnion(
  'type',
  [
    SystemEventSchema,
    UserEventSchema,
    AssistantEventSchema,
    StreamEventSchema,
    ResultEventSchema,
    LogEventSchema,
    PermissionRequestEventSchema,
    HistoryBeginEventSchema,
    HistoryEndEventSchema,
    TurnStateEventSchema,
    SessionListEventSchema,
  ],
) as unknown as z.ZodType<AgentEvent>

export const DaemonEventEnvelopeSchema: z.ZodType<DaemonEventEnvelope> = z
  .object({
    type: z.literal('daemon_event'),
    event: AgentEventSchema,
    metadata: DaemonEventMetadataSchema,
  })
  .strict() as unknown as z.ZodType<DaemonEventEnvelope>

export const DaemonWsEventSchema: z.ZodType<DaemonWsEvent> = z.union([
  AgentEventSchema,
  DaemonEventEnvelopeSchema,
])

export function isDaemonEventEnvelope(
  value: DaemonWsEvent,
): value is DaemonEventEnvelope {
  return value.type === 'daemon_event'
}

/**
 * Lets clients consume either the legacy raw event or an opted-in daemon
 * projection without duplicating envelope detection logic.
 */
export function normalizeDaemonWsEvent(
  value: DaemonWsEvent,
): NormalizedDaemonWsEvent {
  if (isDaemonEventEnvelope(value)) {
    return { event: value.event, metadata: value.metadata }
  }
  return { event: value, metadata: null }
}
