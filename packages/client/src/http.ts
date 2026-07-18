import type {
  AgentEvent,
  DaemonEventMetadata,
  DaemonAgentCreateRequest,
  DaemonAgentDeleteRequest,
  DaemonAgentDeleteResponse,
  DaemonAgentMutationResponse,
  DaemonAgentSource,
  DaemonAgentUpdateRequest,
  DaemonGoalScheduleSummary,
  DaemonManagedAgent,
  DaemonPermissionSnapshot,
  DaemonPermissionUpdate,
  DaemonPermissionUpdateResponse,
  DaemonTask,
  DaemonTaskCancelResponse,
  DaemonTaskOutputResponse,
  Session,
} from '@kode/protocol'
import {
  DaemonAgentCreateRequestSchema,
  DaemonAgentDeleteRequestSchema,
  DaemonAgentDeleteResponseSchema,
  DaemonAgentDetailResponseSchema,
  DaemonAgentListResponseSchema,
  DaemonAgentMutationResponseSchema,
  DaemonAgentSourceSchema,
  DaemonAgentUpdateRequestSchema,
  DaemonGoalScheduleListResponseSchema,
  DaemonGoalScheduleMutationResponseSchema,
  DaemonPermissionSnapshotResponseSchema,
  DaemonPermissionUpdateResponseSchema,
  DaemonPermissionUpdateSchema,
  DaemonTaskCancelResponseSchema,
  DaemonTaskDetailResponseSchema,
  DaemonTaskListResponseSchema,
  DaemonTaskOutputResponseSchema,
  DaemonWsEventSchema,
  normalizeDaemonWsEvent,
} from '@kode/protocol'

import type {
  AgentControlKodeClient,
  CorrelatedAgentEvent,
  RuntimeStatus,
  ForkSessionOptions,
  SendMessageOptions,
  SessionAwareKodeClient,
  SessionControlKodeClient,
  SessionMetadataUpdate,
  GoalScheduleActionRequest,
  GoalScheduleControlKodeClient,
  GoalScheduleCreateRequest,
  TaskControlKodeClient,
  TaskOutputOptions,
  TaskQueryOptions,
  PermissionControlKodeClient,
  ToolPermissionDecision,
  ToolPermissionInputUpdate,
} from './types'

type WebSocketLike = {
  readonly readyState: number
  send: (data: string) => void
  close: () => void
  addEventListener: (
    type: 'open' | 'message' | 'close' | 'error',
    listener: (ev: Event) => void,
    options?: AddEventListenerOptions,
  ) => void
  removeEventListener?: (
    type: 'open' | 'message' | 'close' | 'error',
    listener: (ev: Event) => void,
    options?: EventListenerOptions,
  ) => void
}

type IncomingMessageEvent = Event & { data?: unknown }
type FetchLike = (
  input: string | URL,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
  },
) => Promise<Response>

type ConnectionListener = (connected: boolean) => void

type DecodedDaemonEvent = {
  event: CorrelatedAgentEvent
  metadata: DaemonEventMetadata | null
}

type RequestStreamFilter = {
  accepts: (event: CorrelatedAgentEvent) => boolean
  turnId: () => string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  )
}

function isSafeTaskId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,120}$/.test(value)
}

function isSafeAgentType(value: string): boolean {
  return (
    value.length >= 3 &&
    value.length <= 50 &&
    /^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$/.test(value)
  )
}

function appendOptionalSessionId(
  url: URL,
  sessionId: string | undefined,
): void {
  if (sessionId === undefined) return
  const normalized = sessionId.trim()
  if (!isUuid(normalized)) throw new Error('Invalid session id')
  url.searchParams.set('sessionId', normalized)
}

function createRandomUuidV4(): string {
  const randomUuid = (globalThis as typeof globalThis & { crypto?: Crypto })
    .crypto?.randomUUID
  if (typeof randomUuid === 'function') {
    const value = randomUuid.call(globalThis.crypto)
    if (isUuid(value)) return value
  }

  const bytes = new Uint8Array(16)
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Math.floor(Math.random() * 256)
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80

  const toHex = (value: number) => value.toString(16).padStart(2, '0')
  return [
    toHex(bytes[0]!),
    toHex(bytes[1]!),
    toHex(bytes[2]!),
    toHex(bytes[3]!),
    '-',
    toHex(bytes[4]!),
    toHex(bytes[5]!),
    '-',
    toHex(bytes[6]!),
    toHex(bytes[7]!),
    '-',
    toHex(bytes[8]!),
    toHex(bytes[9]!),
    '-',
    toHex(bytes[10]!),
    toHex(bytes[11]!),
    toHex(bytes[12]!),
    toHex(bytes[13]!),
    toHex(bytes[14]!),
    toHex(bytes[15]!),
  ].join('')
}

function createClientMessageUuid(value: string | undefined): string {
  const candidate = value?.trim() ?? ''
  return isUuid(candidate) ? candidate : createRandomUuidV4()
}

function getEventSessionId(event: CorrelatedAgentEvent): string | null {
  const metadataSessionId = getNonEmptyString(event.sessionId)
  if (metadataSessionId) return metadataSessionId

  if (event.type === 'history_begin' || event.type === 'history_end') {
    return getNonEmptyString(event.sessionId)
  }

  return getNonEmptyString(
    (event as unknown as { session_id?: unknown }).session_id,
  )
}

function getEventMetadata(
  event: CorrelatedAgentEvent,
): DaemonEventMetadata | null {
  const sequence = event.sequence
  if (
    !getNonEmptyString(event.sessionId) ||
    !Number.isInteger(sequence) ||
    sequence < 0 ||
    typeof event.replayed !== 'boolean'
  ) {
    return null
  }

  const turnId = event.turnId
  const clientMessageUuid = event.clientMessageUuid
  const snapshot = event.snapshot === true
  if (
    (turnId !== null && typeof turnId !== 'string') ||
    (clientMessageUuid !== null && typeof clientMessageUuid !== 'string')
  ) {
    return null
  }

  return {
    sessionId: event.sessionId!,
    turnId: turnId ?? null,
    clientMessageUuid: clientMessageUuid ?? null,
    sequence,
    replayed: event.replayed,
    snapshot,
  }
}

function isHandshakeEvent(event: CorrelatedAgentEvent): boolean {
  return (
    (event.type === 'system' && event.subtype === 'init') ||
    event.type === 'history_begin' ||
    event.type === 'history_end'
  )
}

function advancesReplayCursor(event: CorrelatedAgentEvent): boolean {
  return (
    !isHandshakeEvent(event) &&
    event.type !== 'turn_state' &&
    event.type !== 'session_list'
  )
}

function isRequestScopedEvent(event: CorrelatedAgentEvent): boolean {
  return (
    event.type !== 'system' &&
    event.type !== 'history_begin' &&
    event.type !== 'history_end' &&
    event.type !== 'session_list'
  )
}

function decodeDaemonEvent(value: unknown): DecodedDaemonEvent | null {
  const parsed = DaemonWsEventSchema.safeParse(value)
  if (!parsed.success) return null

  const normalized = normalizeDaemonWsEvent(parsed.data)
  if (!normalized.metadata) {
    return { event: normalized.event as CorrelatedAgentEvent, metadata: null }
  }

  return {
    event: {
      ...normalized.event,
      ...normalized.metadata,
    } as CorrelatedAgentEvent,
    metadata: normalized.metadata,
  }
}

function createRequestStreamFilter(args: {
  clientMessageUuid: string
  sessionId: string | null
  correlationKnown: boolean
  onTurnId: (turnId: string) => void
}): RequestStreamFilter {
  let activeTurnId: string | null = null
  let correlationKnown = args.correlationKnown
  let legacyHistoryDepth = 0

  return {
    accepts(event) {
      const metadata = getEventMetadata(event)
      const eventSessionId = metadata?.sessionId ?? getEventSessionId(event)
      if (
        args.sessionId !== null &&
        eventSessionId !== null &&
        eventSessionId !== args.sessionId
      ) {
        return false
      }

      if (metadata) {
        correlationKnown = true
        if (metadata.replayed) return false

        const matchesClient =
          metadata.clientMessageUuid === args.clientMessageUuid
        const matchesTurn =
          activeTurnId !== null && metadata.turnId === activeTurnId

        // A daemon must never associate the active turn with another client
        // message UUID. Reject corrupted/inconsistent metadata rather than
        // letting a matching turn id complete the wrong request.
        if (
          metadata.clientMessageUuid !== null &&
          metadata.clientMessageUuid !== args.clientMessageUuid
        ) {
          return false
        }
        if (
          activeTurnId &&
          metadata.turnId &&
          metadata.turnId !== activeTurnId
        ) {
          return false
        }
        if (!matchesClient && !matchesTurn) return false

        if (!activeTurnId && metadata.turnId) {
          activeTurnId = metadata.turnId
          args.onTurnId(metadata.turnId)
        }
        return isRequestScopedEvent(event)
      }

      // An opted-in daemon must never let a raw terminal event complete a
      // correlated request. This is the multi-client safety boundary.
      if (correlationKnown) return false

      // Legacy daemons have no safe request identifier. Preserve the prior
      // single-request behavior, but never use timing heuristics to infer an
      // assistant-first stream and never consume an explicit history replay.
      if (event.type === 'history_begin') {
        legacyHistoryDepth += 1
        return false
      }
      if (event.type === 'history_end') {
        legacyHistoryDepth = Math.max(0, legacyHistoryDepth - 1)
        return false
      }
      if (legacyHistoryDepth > 0 || isHandshakeEvent(event)) return false

      return isRequestScopedEvent(event)
    },
    turnId: () => activeTurnId,
  }
}

function isSession(value: unknown): value is Session {
  if (!isRecord(value)) return false
  return typeof value.sessionId === 'string'
}

function isSessionListResponse(
  value: unknown,
): value is { sessions: Session[] } {
  if (!isRecord(value)) return false
  return Array.isArray(value.sessions) && value.sessions.every(isSession)
}

function isRuntimeStatus(value: unknown): value is RuntimeStatus {
  if (!isRecord(value)) return false
  const transport = value.transport
  return (
    typeof value.ok === 'boolean' &&
    (transport === 'direct' || transport === 'daemon') &&
    (typeof value.pid === 'number' || value.pid === null) &&
    (typeof value.version === 'string' || value.version === null) &&
    (typeof value.activeSessions === 'number' || value.activeSessions === null)
  )
}

function resolveBaseUrl(baseUrl: string): URL {
  if (typeof window !== 'undefined' && window.location) {
    return new URL(baseUrl, window.location.href)
  }
  return new URL(baseUrl)
}

function toWebSocketUrl(args: {
  baseUrl: URL
  token: string
  workspaceId?: string
  sessionId?: string
  afterSequence?: number
}): URL {
  const wsUrl = new URL(args.baseUrl.toString())
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  wsUrl.pathname = '/ws'
  wsUrl.searchParams.set('token', args.token)
  wsUrl.searchParams.set('correlatedEvents', '1')
  if (args.workspaceId) wsUrl.searchParams.set('workspace', args.workspaceId)
  if (args.sessionId) wsUrl.searchParams.set('session_id', args.sessionId)
  if (
    args.afterSequence !== undefined &&
    Number.isInteger(args.afterSequence) &&
    args.afterSequence >= 0
  ) {
    wsUrl.searchParams.set('afterSequence', String(args.afterSequence))
  }
  return wsUrl
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function httpErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  try {
    const text = await response.text()
    const json = safeJsonParse(text)
    if (isRecord(json) && typeof json.error === 'string' && json.error.trim()) {
      return `${fallback}: ${json.error.trim()}`
    }
    if (text.trim()) return `${fallback}: ${text.trim().slice(0, 200)}`
  } catch {
    // Fall through to status-only message.
  }
  return fallback
}

export class HttpClient
  implements
    SessionAwareKodeClient,
    SessionControlKodeClient,
    TaskControlKodeClient,
    GoalScheduleControlKodeClient,
    PermissionControlKodeClient,
    AgentControlKodeClient
{
  private ws: WebSocketLike | null = null
  private desiredSessionId: string | null = null
  private attachedSessionId: string | null = null
  private connectPromise: Promise<void> | null = null
  private connectionEpoch = 0
  private sendInFlight = false
  private cancelRequested = false
  private promptSent = false
  private cancelPendingSend: (() => void) | null = null
  private activeRequest: {
    clientMessageUuid: string
    turnId: string | null
  } | null = null
  private readonly highestSequenceBySession = new Map<string, number>()
  private readonly correlatedSessions = new Set<string>()
  private readonly eventListeners = new Set<
    (event: CorrelatedAgentEvent) => void
  >()
  private readonly connectionListeners = new Set<ConnectionListener>()

  constructor(
    private readonly options: {
      baseUrl: string
      token: string
      workspaceId?: string
      webSocketImpl?: new (url: string) => WebSocketLike
      fetchImpl?: FetchLike
      connectTimeoutMs?: number
      historySyncTimeoutMs?: number
    },
  ) {}

  isConnected(): boolean {
    return this.ws?.readyState === 1
  }

  disconnect(): void {
    this.closeCurrentSocket()
    this.desiredSessionId = null
    this.attachedSessionId = null
  }

  getAttachedSessionId(): string | null {
    return this.attachedSessionId
  }

  subscribeEvents(listener: (event: CorrelatedAgentEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  async attachSession(sessionId: string): Promise<void> {
    const requestedSessionId = sessionId.trim()
    if (!requestedSessionId) {
      throw new Error('Session id is required')
    }

    if (this.desiredSessionId !== requestedSessionId) {
      this.closeCurrentSocket()
      this.desiredSessionId = requestedSessionId
      this.attachedSessionId = null
    }

    await this.ensureConnected()

    if (this.attachedSessionId !== requestedSessionId) {
      const attached = this.attachedSessionId
      this.closeCurrentSocket()
      this.attachedSessionId = null
      throw new Error(
        `Server attached unexpected session (${attached ?? 'missing'}; expected ${requestedSessionId})`,
      )
    }
  }

  async startSession(): Promise<string> {
    this.closeCurrentSocket()
    this.desiredSessionId = null
    this.attachedSessionId = null

    await this.ensureConnected()

    if (!this.attachedSessionId) {
      throw new Error('Server did not initialize a session')
    }
    return this.attachedSessionId
  }

  private emitEvent(event: CorrelatedAgentEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event)
      } catch {}
    }
  }

  private consumeIncomingEvent(value: unknown): CorrelatedAgentEvent | null {
    const decoded = decodeDaemonEvent(value)
    if (!decoded) return null

    const { event, metadata } = decoded
    if (!metadata) {
      if (event.type === 'system' && event.subtype === 'init') {
        const sessionId = getEventSessionId(event)
        if (sessionId) this.correlatedSessions.delete(sessionId)
      }
      return event
    }

    this.correlatedSessions.add(metadata.sessionId)
    if (
      event.type === 'history_begin' &&
      metadata.replayed &&
      metadata.sequence === 0 &&
      metadata.snapshot
    ) {
      // A durable snapshot replaces the daemon's in-memory journal after a
      // reload. Its sequence-zero boundary invalidates any cursor retained
      // from the prior daemon lifetime before fresh live events arrive.
      this.highestSequenceBySession.delete(metadata.sessionId)
    }
    // Durable transcript snapshots are intentionally all tagged sequence 0.
    // They are distinct history entries, not replayed journal records, so they
    // must reach observers in full and must never change the resume cursor.
    if (metadata.replayed && metadata.sequence === 0) return event
    if (!advancesReplayCursor(event)) return event

    const previous = this.highestSequenceBySession.get(metadata.sessionId)
    const duplicate = previous !== undefined && metadata.sequence <= previous
    if (previous === undefined || metadata.sequence > previous) {
      this.highestSequenceBySession.set(metadata.sessionId, metadata.sequence)
    }

    return duplicate ? null : event
  }

  private emitConnectionChange(connected: boolean): void {
    for (const listener of this.connectionListeners) {
      try {
        listener(connected)
      } catch {}
    }
  }

  onConnectionChange(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener)
    return () => {
      this.connectionListeners.delete(listener)
    }
  }

  private watchSocketFailure(args: {
    ws: WebSocketLike | null
    onClose: () => void
    onError: () => void
  }): () => void {
    const ws = args.ws
    if (!ws) return () => {}

    const onClose = () => {
      args.onClose()
    }
    const onError = () => {
      args.onError()
    }

    ws.addEventListener('close', onClose)
    ws.addEventListener('error', onError)

    return () => {
      try {
        ws.removeEventListener?.('close', onClose)
        ws.removeEventListener?.('error', onError)
      } catch {}
    }
  }

  private closeCurrentSocket(): void {
    const socket = this.ws
    const wasConnected = socket?.readyState === 1

    this.connectionEpoch += 1
    this.connectPromise = null
    this.ws = null

    try {
      socket?.close()
    } catch {}

    if (wasConnected) this.emitConnectionChange(false)
  }

  private async ensureConnected(): Promise<void> {
    if (
      this.ws?.readyState === 1 &&
      this.attachedSessionId &&
      this.attachedSessionId === this.desiredSessionId
    ) {
      return
    }
    if (this.connectPromise) return await this.connectPromise

    const epoch = ++this.connectionEpoch
    const desiredSessionId = this.desiredSessionId
    const promise = this.openSocket({ epoch, desiredSessionId })
    this.connectPromise = promise

    const clearConnectPromise = () => {
      if (this.connectionEpoch === epoch && this.connectPromise === promise) {
        this.connectPromise = null
      }
    }
    void promise.then(clearConnectPromise, clearConnectPromise)

    return await promise
  }

  private async openSocket(args: {
    epoch: number
    desiredSessionId: string | null
  }): Promise<void> {
    const baseUrl = resolveBaseUrl(this.options.baseUrl)
    const wsUrl = toWebSocketUrl({
      baseUrl,
      token: this.options.token,
      workspaceId: this.options.workspaceId,
      sessionId: args.desiredSessionId ?? undefined,
      afterSequence:
        args.desiredSessionId === null
          ? undefined
          : this.highestSequenceBySession.get(args.desiredSessionId),
    })

    const WebSocketImpl =
      this.options.webSocketImpl ??
      ((globalThis as unknown as { WebSocket?: unknown }).WebSocket as
        (new (url: string) => WebSocketLike) | undefined)
    if (!WebSocketImpl) {
      throw new Error('WebSocket implementation not found')
    }
    const ws = new WebSocketImpl(wsUrl.toString())
    this.ws = ws

    await new Promise<void>((resolve, reject) => {
      let opened = false
      let initialized = false
      let historyComplete = args.desiredSessionId === null
      let settled = false
      let connectTimeout: ReturnType<typeof setTimeout> | null = null
      let historySyncTimeout: ReturnType<typeof setTimeout> | null = null

      const isCurrentSocket = () =>
        this.connectionEpoch === args.epoch && this.ws === ws

      const cleanupHandshake = () => {
        if (connectTimeout) clearTimeout(connectTimeout)
        if (historySyncTimeout) clearTimeout(historySyncTimeout)
        try {
          ws.removeEventListener?.('open', onOpen)
        } catch {}
      }

      const completeIfReady = () => {
        if (settled || !opened || !initialized) return
        if (connectTimeout) {
          clearTimeout(connectTimeout)
          connectTimeout = null
        }
        if (!historyComplete) {
          historySyncTimeout ??= setTimeout(() => {
            fail(new Error('WebSocket history synchronization timeout'))
          }, this.options.historySyncTimeoutMs ?? 60_000)
          return
        }
        settled = true
        cleanupHandshake()
        resolve()
      }

      const fail = (error: Error) => {
        if (settled) return
        settled = true
        cleanupHandshake()
        if (isCurrentSocket()) {
          this.ws = null
          this.emitConnectionChange(false)
        }
        try {
          ws.close()
        } catch {}
        reject(error)
      }

      const onMessage = (ev: Event) => {
        if (!isCurrentSocket()) return

        const raw = (ev as IncomingMessageEvent).data
        const text = typeof raw === 'string' ? raw : String(raw ?? '')
        const event = this.consumeIncomingEvent(safeJsonParse(text))
        if (!event) return
        if (event.type === 'system' && event.subtype === 'init') {
          const announcedSessionId = event.session_id?.trim() ?? ''
          if (!announcedSessionId) {
            fail(new Error('Session init event is missing session_id'))
            return
          }

          if (
            args.desiredSessionId !== null &&
            announcedSessionId !== args.desiredSessionId
          ) {
            fail(
              new Error(
                `Server attached unexpected session (${announcedSessionId}; expected ${args.desiredSessionId})`,
              ),
            )
            return
          }

          this.attachedSessionId = announcedSessionId
          if (args.desiredSessionId === null) {
            this.desiredSessionId = announcedSessionId
          }
          initialized = true
        }
        if (
          event.type === 'history_end' &&
          args.desiredSessionId !== null &&
          event.sessionId === args.desiredSessionId
        ) {
          historyComplete = true
        }

        this.emitEvent(event)
        completeIfReady()
      }

      const onOpen = () => {
        if (!isCurrentSocket()) {
          fail(new Error('WebSocket connection attempt was superseded'))
          return
        }
        opened = true
        this.emitConnectionChange(true)
        completeIfReady()
      }
      const onError = () => {
        fail(new Error('WebSocket connection error'))
      }
      const onClose = () => {
        if (isCurrentSocket()) {
          this.ws = null
          this.emitConnectionChange(false)
        }
        if (!settled) {
          fail(
            new Error(
              'WebSocket connection closed before session synchronization completed',
            ),
          )
        }
      }

      // Register message handling before `open` so an immediate init event
      // cannot be lost between the open callback and an awaited continuation.
      ws.addEventListener('message', onMessage)
      ws.addEventListener('open', onOpen, { once: true })
      ws.addEventListener('error', onError)
      ws.addEventListener('close', onClose)

      connectTimeout = setTimeout(() => {
        fail(new Error('WebSocket connect timeout'))
      }, this.options.connectTimeoutMs ?? 5_000)
    })
  }

  private send(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== 1) {
      throw new Error('HttpClient is not connected')
    }
    this.ws.send(JSON.stringify(payload))
  }

  private getFetchImpl(): FetchLike {
    const fetchImpl =
      this.options.fetchImpl ??
      ((globalThis as unknown as { fetch?: unknown }).fetch as
        FetchLike | undefined)
    if (!fetchImpl) {
      throw new Error('Fetch implementation not found')
    }
    return fetchImpl
  }

  private toApiUrl(pathname: string): URL {
    const url = resolveBaseUrl(this.options.baseUrl)
    url.pathname = pathname
    url.search = ''
    if (this.options.workspaceId) {
      url.searchParams.set('workspace', this.options.workspaceId)
    }
    return url
  }

  cancelRequest(): void {
    if (this.sendInFlight) {
      this.cancelRequested = true
      if (!this.promptSent) {
        this.cancelPendingSend?.()
        return
      }
    }
    if (!this.ws || this.ws.readyState !== 1) return
    this.send({
      type: 'cancel',
      ...(this.activeRequest?.turnId
        ? { turnId: this.activeRequest.turnId }
        : {}),
      ...(this.activeRequest?.clientMessageUuid
        ? { clientMessageUuid: this.activeRequest.clientMessageUuid }
        : {}),
    })
  }

  async approveToolUse(
    toolUseId: string,
    options?: {
      decision?: Exclude<ToolPermissionDecision, 'deny'>
      updatedInput?: ToolPermissionInputUpdate | null
    },
  ): Promise<void> {
    const decision: Exclude<ToolPermissionDecision, 'deny'> =
      options?.decision ?? 'allow_once'
    this.send({
      type: 'permission_response',
      request_id: toolUseId,
      decision,
      ...(options?.updatedInput ? { updated_input: options.updatedInput } : {}),
    })
  }

  async denyToolUse(
    toolUseId: string,
    reason?: string,
    options?: { updatedInput?: ToolPermissionInputUpdate | null },
  ): Promise<void> {
    this.send({
      type: 'permission_response',
      request_id: toolUseId,
      decision: 'deny',
      ...(options?.updatedInput ? { updated_input: options.updatedInput } : {}),
      ...(reason && reason.trim() ? { rejection_message: reason.trim() } : {}),
    })
  }

  async listSessions(): Promise<Session[]> {
    const url = this.toApiUrl('/api/sessions')
    const response = await this.getFetchImpl()(url, {
      headers: {
        authorization: `Bearer ${this.options.token}`,
      },
    })

    if (!response.ok) {
      throw new Error(`Failed to list sessions (${response.status})`)
    }

    const json: unknown = await response.json()
    if (!isSessionListResponse(json)) {
      throw new Error('Invalid sessions response')
    }

    return json.sessions
  }

  async getRuntimeStatus(): Promise<RuntimeStatus> {
    const url = this.toApiUrl('/api/health')
    const response = await this.getFetchImpl()(url, {
      headers: {
        authorization: `Bearer ${this.options.token}`,
      },
    })

    if (!response.ok) {
      throw new Error(`Failed to read runtime status (${response.status})`)
    }

    const json: unknown = await response.json()
    if (!isRuntimeStatus(json)) {
      throw new Error('Invalid runtime status response')
    }

    return json
  }

  async loadSession(sessionId: string): Promise<Session> {
    const url = this.toApiUrl(`/api/sessions/${encodeURIComponent(sessionId)}`)
    const response = await this.getFetchImpl()(url, {
      headers: {
        authorization: `Bearer ${this.options.token}`,
      },
    })

    if (!response.ok) {
      throw new Error(`Failed to load session (${response.status})`)
    }

    const json: unknown = await response.json()
    if (!isSession(json)) {
      throw new Error('Invalid session response')
    }

    const events = Array.isArray(json.events)
      ? json.events
          .map(event => decodeDaemonEvent(event)?.event ?? null)
          .filter((event): event is CorrelatedAgentEvent => event !== null)
      : undefined

    return { ...json, events }
  }

  async deleteSession(sessionId: string): Promise<void> {
    const normalizedSessionId = sessionId.trim()
    if (!isUuid(normalizedSessionId)) {
      throw new Error('Invalid session id')
    }

    const url = this.toApiUrl(
      `/api/sessions/${encodeURIComponent(normalizedSessionId)}`,
    )
    const response = await this.getFetchImpl()(url, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${this.options.token}`,
      },
    })
    if (!response.ok) {
      throw new Error(`Failed to delete session (${response.status})`)
    }
  }

  async updateSessionMetadata(
    sessionId: string,
    update: SessionMetadataUpdate,
  ): Promise<Session> {
    const normalizedSessionId = sessionId.trim()
    if (!isUuid(normalizedSessionId)) {
      throw new Error('Invalid session id')
    }
    const url = this.toApiUrl(
      `/api/sessions/${encodeURIComponent(normalizedSessionId)}`,
    )
    const response = await this.getFetchImpl()(url, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${this.options.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(update),
    })
    if (!response.ok) {
      throw new Error(`Failed to update session (${response.status})`)
    }
    const json: unknown = await response.json()
    if (!isRecord(json) || !isSession(json.session)) {
      throw new Error('Invalid session update response')
    }
    return json.session
  }

  async forkSession(
    sessionId: string,
    options: ForkSessionOptions = {},
  ): Promise<Session> {
    const normalizedSessionId = sessionId.trim()
    if (!isUuid(normalizedSessionId)) {
      throw new Error('Invalid session id')
    }
    if (options.newSessionId && !isUuid(options.newSessionId.trim())) {
      throw new Error('Invalid newSessionId')
    }
    const url = this.toApiUrl(
      `/api/sessions/${encodeURIComponent(normalizedSessionId)}/fork`,
    )
    const response = await this.getFetchImpl()(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(options),
    })
    if (!response.ok) {
      throw new Error(`Failed to fork session (${response.status})`)
    }
    const json: unknown = await response.json()
    if (!isRecord(json) || !isSession(json.session)) {
      throw new Error('Invalid session fork response')
    }
    return json.session
  }

  async listTasks(options: TaskQueryOptions = {}): Promise<DaemonTask[]> {
    const url = this.toApiUrl('/api/tasks')
    appendOptionalSessionId(url, options.sessionId)
    const response = await this.getFetchImpl()(url, {
      headers: { authorization: `Bearer ${this.options.token}` },
    })
    if (!response.ok) {
      throw new Error(`Failed to list tasks (${response.status})`)
    }
    const parsed = DaemonTaskListResponseSchema.safeParse(await response.json())
    if (!parsed.success) throw new Error('Invalid tasks response')
    return (parsed.data as unknown as { tasks: DaemonTask[] }).tasks
  }

  async listGoalSchedules(
    options: TaskQueryOptions = {},
  ): Promise<DaemonGoalScheduleSummary[]> {
    const url = this.toApiUrl('/api/goal-schedules')
    appendOptionalSessionId(url, options.sessionId)
    const response = await this.getFetchImpl()(url, {
      headers: { authorization: `Bearer ${this.options.token}` },
    })
    if (!response.ok) {
      throw new Error(
        await httpErrorMessage(
          response,
          `Failed to list goal schedules (${response.status})`,
        ),
      )
    }
    const parsed = DaemonGoalScheduleListResponseSchema.safeParse(
      await response.json(),
    )
    if (!parsed.success) throw new Error('Invalid goal schedules response')
    return parsed.data.schedules
  }

  async createGoalSchedule(
    request: GoalScheduleCreateRequest,
  ): Promise<DaemonGoalScheduleSummary> {
    const sessionId = request.sessionId.trim()
    if (!isUuid(sessionId)) throw new Error('Invalid session id')
    const objective = request.objective.trim()
    if (!objective) throw new Error('Objective is required')
    const response = await this.getFetchImpl()(
      this.toApiUrl('/api/goal-schedules'),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sessionId,
          objective,
          schedule: request.schedule,
        }),
      },
    )
    if (!response.ok) {
      throw new Error(
        await httpErrorMessage(
          response,
          `Failed to create goal schedule (${response.status})`,
        ),
      )
    }
    const parsed = DaemonGoalScheduleMutationResponseSchema.safeParse(
      await response.json(),
    )
    if (!parsed.success) {
      throw new Error('Invalid create goal schedule response')
    }
    return parsed.data.schedule
  }

  async transitionGoalSchedule(
    scheduleId: string,
    request: GoalScheduleActionRequest,
  ): Promise<DaemonGoalScheduleSummary> {
    const id = scheduleId.trim()
    if (!id) throw new Error('Invalid schedule id')
    const sessionId = request.sessionId.trim()
    if (!isUuid(sessionId)) throw new Error('Invalid session id')
    if (
      !Number.isSafeInteger(request.expectedRevision) ||
      request.expectedRevision < 1
    ) {
      throw new Error('Invalid expected revision')
    }
    if (
      request.action !== 'pause' &&
      request.action !== 'resume' &&
      request.action !== 'cancel'
    ) {
      throw new Error('Invalid schedule action')
    }
    const response = await this.getFetchImpl()(
      this.toApiUrl(`/api/goal-schedules/${encodeURIComponent(id)}/actions`),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sessionId,
          expectedRevision: request.expectedRevision,
          action: request.action,
          ...(request.reason?.trim() ? { reason: request.reason.trim() } : {}),
        }),
      },
    )
    if (!response.ok) {
      throw new Error(
        await httpErrorMessage(
          response,
          `Failed to ${request.action} goal schedule (${response.status})`,
        ),
      )
    }
    const parsed = DaemonGoalScheduleMutationResponseSchema.safeParse(
      await response.json(),
    )
    if (!parsed.success) {
      throw new Error('Invalid goal schedule action response')
    }
    return parsed.data.schedule
  }

  async getTask(
    taskId: string,
    options: TaskQueryOptions = {},
  ): Promise<DaemonTask> {
    const normalizedTaskId = taskId.trim()
    if (!isSafeTaskId(normalizedTaskId)) throw new Error('Invalid task id')
    const url = this.toApiUrl(
      `/api/tasks/${encodeURIComponent(normalizedTaskId)}`,
    )
    appendOptionalSessionId(url, options.sessionId)
    const response = await this.getFetchImpl()(url, {
      headers: { authorization: `Bearer ${this.options.token}` },
    })
    if (!response.ok) {
      throw new Error(`Failed to load task (${response.status})`)
    }
    const parsed = DaemonTaskDetailResponseSchema.safeParse(
      await response.json(),
    )
    if (!parsed.success) throw new Error('Invalid task response')
    return (parsed.data as unknown as { task: DaemonTask }).task
  }

  async getTaskOutput(
    taskId: string,
    options: TaskOutputOptions = {},
  ): Promise<DaemonTaskOutputResponse> {
    const normalizedTaskId = taskId.trim()
    if (!isSafeTaskId(normalizedTaskId)) throw new Error('Invalid task id')
    if (
      options.tailLines !== undefined &&
      (!Number.isSafeInteger(options.tailLines) ||
        options.tailLines < 1 ||
        options.tailLines > 1000)
    ) {
      throw new Error('tailLines must be an integer between 1 and 1000')
    }
    const url = this.toApiUrl(
      `/api/tasks/${encodeURIComponent(normalizedTaskId)}/output`,
    )
    appendOptionalSessionId(url, options.sessionId)
    if (options.tailLines !== undefined) {
      url.searchParams.set('tail', String(options.tailLines))
    }
    const response = await this.getFetchImpl()(url, {
      headers: { authorization: `Bearer ${this.options.token}` },
    })
    if (!response.ok) {
      throw new Error(`Failed to read task output (${response.status})`)
    }
    const parsed = DaemonTaskOutputResponseSchema.safeParse(
      await response.json(),
    )
    if (!parsed.success) throw new Error('Invalid task output response')
    return parsed.data as unknown as DaemonTaskOutputResponse
  }

  async cancelTask(
    taskId: string,
    options: TaskQueryOptions = {},
  ): Promise<DaemonTaskCancelResponse> {
    const normalizedTaskId = taskId.trim()
    if (!isSafeTaskId(normalizedTaskId)) throw new Error('Invalid task id')
    const url = this.toApiUrl(
      `/api/tasks/${encodeURIComponent(normalizedTaskId)}/cancel`,
    )
    appendOptionalSessionId(url, options.sessionId)
    const response = await this.getFetchImpl()(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.options.token}` },
    })
    if (!response.ok) {
      throw new Error(`Failed to cancel task (${response.status})`)
    }
    const parsed = DaemonTaskCancelResponseSchema.safeParse(
      await response.json(),
    )
    if (!parsed.success) throw new Error('Invalid task cancellation response')
    return parsed.data as unknown as DaemonTaskCancelResponse
  }

  async getPermissions(
    options: TaskQueryOptions = {},
  ): Promise<DaemonPermissionSnapshot> {
    const url = this.toApiUrl('/api/permissions')
    appendOptionalSessionId(url, options.sessionId)
    const response = await this.getFetchImpl()(url, {
      headers: { authorization: `Bearer ${this.options.token}` },
    })
    if (!response.ok) {
      throw new Error(`Failed to read permissions (${response.status})`)
    }
    const parsed = DaemonPermissionSnapshotResponseSchema.safeParse(
      await response.json(),
    )
    if (!parsed.success) throw new Error('Invalid permission response')
    return (parsed.data as unknown as { permission: DaemonPermissionSnapshot })
      .permission
  }

  async updatePermissions(args: {
    sessionId?: string
    update: DaemonPermissionUpdate
  }): Promise<DaemonPermissionUpdateResponse> {
    const update = DaemonPermissionUpdateSchema.safeParse(args.update)
    if (!update.success) throw new Error('Invalid permission update')
    const sessionId = args.sessionId?.trim()
    if (sessionId !== undefined && !isUuid(sessionId)) {
      throw new Error('Invalid session id')
    }
    const url = this.toApiUrl('/api/permissions')
    const response = await this.getFetchImpl()(url, {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${this.options.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...(sessionId ? { sessionId } : {}),
        update: update.data,
      }),
    })
    if (!response.ok) {
      throw new Error(`Failed to update permissions (${response.status})`)
    }
    const parsed = DaemonPermissionUpdateResponseSchema.safeParse(
      await response.json(),
    )
    if (!parsed.success) throw new Error('Invalid permission update response')
    return parsed.data as unknown as DaemonPermissionUpdateResponse
  }

  async listAgents(): Promise<DaemonManagedAgent[]> {
    const response = await this.getFetchImpl()(this.toApiUrl('/api/agents'), {
      headers: { authorization: `Bearer ${this.options.token}` },
    })
    if (!response.ok) {
      throw new Error(`Failed to list agents (${response.status})`)
    }
    const parsed = DaemonAgentListResponseSchema.safeParse(
      await response.json(),
    )
    if (!parsed.success) throw new Error('Invalid agents response')
    return parsed.data.agents as DaemonManagedAgent[]
  }

  async getAgent(
    agentType: string,
    source: DaemonAgentSource,
  ): Promise<DaemonManagedAgent> {
    const normalizedAgentType = agentType.trim()
    if (!isSafeAgentType(normalizedAgentType)) {
      throw new Error('Invalid agent type')
    }
    if (!DaemonAgentSourceSchema.safeParse(source).success) {
      throw new Error('Invalid mutable agent source')
    }
    const url = this.toApiUrl(
      `/api/agents/${encodeURIComponent(normalizedAgentType)}`,
    )
    url.searchParams.set('source', source)
    const response = await this.getFetchImpl()(url, {
      headers: { authorization: `Bearer ${this.options.token}` },
    })
    if (!response.ok) {
      throw new Error(`Failed to load agent (${response.status})`)
    }
    const parsed = DaemonAgentDetailResponseSchema.safeParse(
      await response.json(),
    )
    if (!parsed.success) throw new Error('Invalid agent response')
    return parsed.data.agent as DaemonManagedAgent
  }

  async createAgent(
    request: DaemonAgentCreateRequest,
  ): Promise<DaemonAgentMutationResponse> {
    const parsedRequest = DaemonAgentCreateRequestSchema.safeParse(request)
    if (!parsedRequest.success) throw new Error('Invalid agent create request')
    const response = await this.getFetchImpl()(this.toApiUrl('/api/agents'), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(parsedRequest.data),
    })
    if (!response.ok) {
      throw new Error(`Failed to create agent (${response.status})`)
    }
    const parsed = DaemonAgentMutationResponseSchema.safeParse(
      await response.json(),
    )
    if (!parsed.success) throw new Error('Invalid agent create response')
    return parsed.data as DaemonAgentMutationResponse
  }

  async updateAgent(
    agentType: string,
    request: DaemonAgentUpdateRequest,
  ): Promise<DaemonAgentMutationResponse> {
    const normalizedAgentType = agentType.trim()
    if (!isSafeAgentType(normalizedAgentType)) {
      throw new Error('Invalid agent type')
    }
    const parsedRequest = DaemonAgentUpdateRequestSchema.safeParse(request)
    if (
      !parsedRequest.success ||
      parsedRequest.data.agent.agentType !== normalizedAgentType
    ) {
      throw new Error('Invalid agent update request')
    }
    const response = await this.getFetchImpl()(
      this.toApiUrl(`/api/agents/${encodeURIComponent(normalizedAgentType)}`),
      {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${this.options.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(parsedRequest.data),
      },
    )
    if (!response.ok) {
      throw new Error(`Failed to update agent (${response.status})`)
    }
    const parsed = DaemonAgentMutationResponseSchema.safeParse(
      await response.json(),
    )
    if (!parsed.success) throw new Error('Invalid agent update response')
    return parsed.data as DaemonAgentMutationResponse
  }

  async deleteAgent(
    agentType: string,
    request: DaemonAgentDeleteRequest,
  ): Promise<DaemonAgentDeleteResponse> {
    const normalizedAgentType = agentType.trim()
    if (!isSafeAgentType(normalizedAgentType)) {
      throw new Error('Invalid agent type')
    }
    const parsedRequest = DaemonAgentDeleteRequestSchema.safeParse(request)
    if (!parsedRequest.success) throw new Error('Invalid agent delete request')
    const response = await this.getFetchImpl()(
      this.toApiUrl(`/api/agents/${encodeURIComponent(normalizedAgentType)}`),
      {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${this.options.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(parsedRequest.data),
      },
    )
    if (!response.ok) {
      throw new Error(`Failed to delete agent (${response.status})`)
    }
    const parsed = DaemonAgentDeleteResponseSchema.safeParse(
      await response.json(),
    )
    if (!parsed.success) {
      throw new Error('Invalid agent delete response')
    }
    return parsed.data as DaemonAgentDeleteResponse
  }

  async *sendMessage(
    message: string,
    options?: SendMessageOptions,
  ): AsyncGenerator<CorrelatedAgentEvent> {
    if (this.sendInFlight) {
      throw new Error('Another message is already in flight for this client')
    }
    const clientMessageUuid = createClientMessageUuid(
      options?.clientMessageUuid,
    )
    this.sendInFlight = true
    this.cancelRequested = false
    this.promptSent = false
    this.activeRequest = { clientMessageUuid, turnId: null }
    let cancelPendingSend: (() => void) | null = null

    try {
      const cancelled = new Promise<'cancelled'>(resolve => {
        cancelPendingSend = () => resolve('cancelled')
        this.cancelPendingSend = cancelPendingSend
      })
      const connected = this.ensureConnected().then(() => 'connected' as const)
      const connectionOutcome = await Promise.race([connected, cancelled])
      if (connectionOutcome === 'cancelled') return
      if (this.cancelPendingSend === cancelPendingSend) {
        this.cancelPendingSend = null
      }
      if (this.cancelRequested) return
      const ws = this.ws

      const queue: CorrelatedAgentEvent[] = []
      let resolveNext: (() => void) | null = null
      let done = false
      let streamError: Error | null = null
      const sessionId = this.attachedSessionId ?? this.desiredSessionId
      const requestFilter = createRequestStreamFilter({
        clientMessageUuid,
        sessionId,
        correlationKnown:
          sessionId !== null && this.correlatedSessions.has(sessionId),
        onTurnId: turnId => {
          if (
            this.activeRequest?.clientMessageUuid === clientMessageUuid &&
            this.activeRequest.turnId === null
          ) {
            this.activeRequest.turnId = turnId
          }
        },
      })

      const wake = () => {
        if (!resolveNext) return
        const r = resolveNext
        resolveNext = null
        r()
      }

      const unsubscribe = this.subscribeEvents(event => {
        if (!requestFilter.accepts(event)) return
        queue.push(event)

        if (event.type === 'result') {
          done = true
        }

        wake()
      })

      const failStream = (failureMessage: string) => {
        if (done) return
        streamError = new Error(failureMessage)
        done = true
        wake()
      }
      const unwatchFailure = this.watchSocketFailure({
        ws,
        onClose: () =>
          failStream(
            'WebSocket connection closed before the response completed',
          ),
        onError: () =>
          failStream(
            'WebSocket connection error before the response completed',
          ),
      })

      try {
        this.send({
          type: 'prompt',
          prompt: message,
          clientMessageUuid,
        })
        this.promptSent = true

        while (!done || queue.length > 0) {
          if (queue.length === 0) {
            if (streamError) throw streamError
            await new Promise<void>(resolve => {
              resolveNext = resolve
            })
            continue
          }

          const next = queue.shift()
          if (next) yield next
        }
        if (streamError) throw streamError
      } finally {
        unsubscribe()
        unwatchFailure()
      }
    } finally {
      if (this.cancelPendingSend === cancelPendingSend) {
        this.cancelPendingSend = null
      }
      this.promptSent = false
      this.cancelRequested = false
      this.sendInFlight = false
      if (this.activeRequest?.clientMessageUuid === clientMessageUuid) {
        this.activeRequest = null
      }
    }
  }
}
