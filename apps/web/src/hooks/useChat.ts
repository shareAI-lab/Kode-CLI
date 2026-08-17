import React from 'react'

import type {
  CorrelatedAgentEvent,
  KodeClient,
  SessionAwareKodeClient,
} from '@kode/client'
import type {
  AgentEvent,
  PermissionRequestEvent,
  Session,
} from '@kode/protocol'
import {
  expandWebPastedTextPlaceholders,
  insertWebPastedTextPlaceholder,
  retainReferencedWebPastedTextSegments,
  type WebPastedTextSegment,
} from '../lib/pastedText'

function isPermissionRequest(
  event: AgentEvent,
): event is PermissionRequestEvent {
  return event.type === 'permission_request'
}

function isSessionAwareClient(
  client: KodeClient | null,
): client is SessionAwareKodeClient {
  return Boolean(
    client &&
    'attachSession' in client &&
    typeof client.attachSession === 'function' &&
    'startSession' in client &&
    typeof client.startSession === 'function' &&
    'subscribeEvents' in client &&
    typeof client.subscribeEvents === 'function' &&
    'getAttachedSessionId' in client &&
    typeof client.getAttachedSessionId === 'function',
  )
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function createErrorLogEvent(error: unknown): AgentEvent {
  return {
    type: 'log',
    log: {
      level: 'error',
      message: getErrorMessage(error),
    },
  }
}

function getEventSessionId(event: CorrelatableAgentEvent): string | null {
  const metadataSessionId = getNonEmptyString(event.sessionId)
  if (metadataSessionId) return metadataSessionId

  if (event.type === 'history_begin' || event.type === 'history_end') {
    return event.sessionId
  }
  if ('session_id' in event && typeof event.session_id === 'string') {
    return event.session_id
  }
  return null
}

function getEventIdentity(event: AgentEvent): string | null {
  if ('uuid' in event && typeof event.uuid === 'string' && event.uuid) {
    return `${event.type}:${event.uuid}`
  }
  if (event.type === 'permission_request') {
    return `${event.type}:${event.request_id}`
  }
  return null
}

function getTurnStateSending(event: AgentEvent): boolean | null {
  if (event.type !== 'turn_state') return null
  return event.state === 'running'
}

type ActiveRequestCorrelation = Readonly<{
  clientMessageUuid: string
  turnId: string | null
}>

type CorrelatableAgentEvent = CorrelatedAgentEvent

type EventRequestCorrelation = Readonly<{
  clientMessageUuid: string | null
  hasDaemonMetadata: boolean
  turnId: string | null
  replayed: boolean
}>

type RequestStateUpdate = Readonly<{
  sending: boolean
  permission?: PermissionRequestEvent | null
}>

type EventHandlingMode = 'history-begin' | 'history-end' | 'history' | 'live'

function getNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized || null
}

/**
 * Legacy history payloads have no replay metadata. The history frame is the
 * authoritative replay boundary, so every payload between its markers is
 * transcript-only regardless of its envelope shape.
 */
function getEventHandlingMode(
  event: AgentEvent,
  historyReplayInProgress: boolean,
): EventHandlingMode {
  if (event.type === 'history_begin') return 'history-begin'
  if (event.type === 'history_end') return 'history-end'
  return historyReplayInProgress ? 'history' : 'live'
}

function getEventRequestCorrelation(
  event: CorrelatableAgentEvent,
): EventRequestCorrelation {
  const sequence = event.sequence
  return {
    clientMessageUuid: getNonEmptyString(event.clientMessageUuid),
    hasDaemonMetadata:
      getNonEmptyString(event.sessionId) !== null &&
      typeof sequence === 'number' &&
      Number.isInteger(sequence) &&
      sequence >= 0 &&
      typeof event.replayed === 'boolean',
    turnId: getNonEmptyString(event.turnId),
    replayed: event.replayed === true,
  }
}

/**
 * Treat an event without request metadata as a legacy/direct event. Once an
 * event identifies another request, though, it must never affect this
 * request's loading or permission UI.
 */
function eventBelongsToActiveRequest(
  event: CorrelatableAgentEvent,
  activeRequest: ActiveRequestCorrelation,
): boolean {
  const correlation = getEventRequestCorrelation(event)
  if (correlation.replayed) return false

  const hasRequestMetadata = Boolean(
    correlation.clientMessageUuid || correlation.turnId,
  )
  if (!hasRequestMetadata) return !correlation.hasDaemonMetadata

  if (
    correlation.clientMessageUuid &&
    correlation.clientMessageUuid !== activeRequest.clientMessageUuid
  ) {
    return false
  }

  if (
    correlation.turnId &&
    activeRequest.turnId &&
    correlation.turnId !== activeRequest.turnId
  ) {
    return false
  }

  if (correlation.clientMessageUuid === activeRequest.clientMessageUuid) {
    return true
  }

  return (
    correlation.turnId !== null && correlation.turnId === activeRequest.turnId
  )
}

function observeActiveRequestTurn(
  activeRequest: ActiveRequestCorrelation,
  event: CorrelatableAgentEvent,
): ActiveRequestCorrelation {
  const correlation = getEventRequestCorrelation(event)
  if (
    correlation.clientMessageUuid !== activeRequest.clientMessageUuid ||
    !correlation.turnId ||
    correlation.turnId === activeRequest.turnId
  ) {
    return activeRequest
  }

  return { ...activeRequest, turnId: correlation.turnId }
}

function getRequestStateUpdate(event: AgentEvent): RequestStateUpdate | null {
  const turnStateSending = getTurnStateSending(event)
  if (turnStateSending !== null) {
    return {
      sending: turnStateSending,
      ...(turnStateSending ? {} : { permission: null }),
    }
  }

  if (isPermissionRequest(event)) {
    return { sending: true, permission: event }
  }

  if (event.type === 'result') {
    return { sending: false, permission: null }
  }

  if (event.type === 'user') return { sending: true }
  return null
}

function getRequestStateUpdateForActiveRequest(
  event: CorrelatableAgentEvent,
  activeRequest: ActiveRequestCorrelation | null,
): RequestStateUpdate | null {
  if (!activeRequest) {
    // A correlated daemon envelope belongs to some request, but there is no
    // local request to associate it with. Keep it in the transcript only.
    return getEventRequestCorrelation(event).hasDaemonMetadata
      ? null
      : getRequestStateUpdate(event)
  }

  if (!eventBelongsToActiveRequest(event, activeRequest)) return null
  return getRequestStateUpdate(event)
}

function createClientMessageUuid(): string {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi?.randomUUID === 'function') {
    return cryptoApi.randomUUID()
  }

  const bytes = new Uint8Array(16)
  if (typeof cryptoApi?.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80

  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0'))
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-')
}

function appendUniqueEvent(
  events: AgentEvent[],
  event: AgentEvent,
): AgentEvent[] {
  return appendUniqueEvents(events, [event])
}

function appendUniqueEvents(
  events: AgentEvent[],
  additions: readonly AgentEvent[],
): AgentEvent[] {
  if (additions.length === 0) return events

  const identities = new Set<string>()
  for (const event of events) {
    const identity = getEventIdentity(event)
    if (identity) identities.add(identity)
  }

  let nextEvents: AgentEvent[] | null = null
  for (const event of additions) {
    const identity = getEventIdentity(event)
    if (identity && identities.has(identity)) continue
    if (identity) identities.add(identity)
    if (!nextEvents) nextEvents = [...events]
    nextEvents.push(event)
  }

  return nextEvents ?? events
}

const EVENT_FLUSH_DELAY_MS = 50

export function useChat(args: {
  client: KodeClient | null
  resetKey: string
  onNewSession: () => void
}): {
  sessions: Session[]
  selectedSessionId: string | null
  events: AgentEvent[]
  permissionRequest: PermissionRequestEvent | null
  input: string
  failedPrompt: string | null
  setInput: (v: string) => void
  insertPastedText: (args: {
    text: string
    selectionStart: number | null
    selectionEnd: number | null
  }) => { cursorOffset: number } | null
  sending: boolean
  send: () => Promise<void>
  cancel: () => void
  restoreFailedPrompt: () => void
  startNewSession: () => void
  selectSession: (id: string) => Promise<void>
  clearPermissionRequest: () => void
} {
  const onNewSession = args.onNewSession
  const sessionClient = isSessionAwareClient(args.client) ? args.client : null
  const [sessions, setSessions] = React.useState<Session[]>([])
  const [selectedSessionId, setSelectedSessionId] = React.useState<
    string | null
  >(null)
  const [events, setEvents] = React.useState<AgentEvent[]>([])
  const [permissionRequest, setPermissionRequest] =
    React.useState<PermissionRequestEvent | null>(null)
  const [input, setInput] = React.useState('')
  const [failedPrompt, setFailedPrompt] = React.useState<string | null>(null)
  const [sending, setSending] = React.useState(false)
  const inputRef = React.useRef('')
  const pastedTextCounterRef = React.useRef(1)
  const pastedTextSegmentsRef = React.useRef<WebPastedTextSegment[]>([])
  const eventBufferRef = React.useRef<AgentEvent[]>([])
  const historyBufferRef = React.useRef<AgentEvent[] | null>(null)
  const selectedSessionIdRef = React.useRef<string | null>(null)
  const activeRequestRef = React.useRef<ActiveRequestCorrelation | null>(null)
  const selectionEpochRef = React.useRef(0)
  const sessionRefreshEpochRef = React.useRef(0)
  const eventFlushTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )

  const appendBufferedEvents = React.useCallback(() => {
    const buffered = eventBufferRef.current
    if (buffered.length === 0) return
    eventBufferRef.current = []
    setEvents(prev => appendUniqueEvents(prev, buffered))
  }, [])

  const clearEventFlushTimer = React.useCallback(() => {
    if (!eventFlushTimerRef.current) return
    clearTimeout(eventFlushTimerRef.current)
    eventFlushTimerRef.current = null
  }, [])

  const flushBufferedEvents = React.useCallback(() => {
    clearEventFlushTimer()
    appendBufferedEvents()
  }, [appendBufferedEvents, clearEventFlushTimer])

  const clearBufferedEvents = React.useCallback(() => {
    clearEventFlushTimer()
    eventBufferRef.current = []
    historyBufferRef.current = null
  }, [clearEventFlushTimer])

  const scheduleEventFlush = React.useCallback(() => {
    if (eventFlushTimerRef.current) return
    eventFlushTimerRef.current = setTimeout(() => {
      eventFlushTimerRef.current = null
      appendBufferedEvents()
    }, EVENT_FLUSH_DELAY_MS)
  }, [appendBufferedEvents])

  const enqueueEvent = React.useCallback(
    (event: AgentEvent) => {
      eventBufferRef.current.push(event)
      scheduleEventFlush()
    },
    [scheduleEventFlush],
  )

  const applyRequestStateUpdate = React.useCallback(
    (update: RequestStateUpdate | null) => {
      if (!update) return
      setSending(update.sending)
      if (update.permission !== undefined) {
        setPermissionRequest(update.permission)
      }
    },
    [],
  )

  const refreshSessions = React.useCallback(async () => {
    const client = args.client
    const refreshEpoch = ++sessionRefreshEpochRef.current
    if (!client) {
      setSessions([])
      return
    }
    try {
      const next = await client.listSessions()
      if (sessionRefreshEpochRef.current === refreshEpoch) {
        setSessions(next)
      }
    } catch {
      // ignore
    }
  }, [args.client])

  const handleEvent = React.useCallback(
    (event: AgentEvent) => {
      const handlingMode = getEventHandlingMode(
        event,
        historyBufferRef.current !== null,
      )

      if (handlingMode === 'live' && event.type === 'session_list') {
        sessionRefreshEpochRef.current += 1
        setSessions(event.sessions)
        return
      }

      if (
        handlingMode === 'live' &&
        event.type === 'system' &&
        event.subtype === 'init' &&
        typeof event.session_id === 'string'
      ) {
        selectedSessionIdRef.current = event.session_id
        setSelectedSessionId(event.session_id)
        return
      }

      const eventSessionId = getEventSessionId(event)
      const selectedId =
        selectedSessionIdRef.current ??
        sessionClient?.getAttachedSessionId() ??
        null
      if (eventSessionId && selectedId && eventSessionId !== selectedId) return

      if (handlingMode === 'history-begin') {
        clearBufferedEvents()
        historyBufferRef.current = []
        return
      }

      if (handlingMode === 'history-end') {
        clearEventFlushTimer()
        const history = historyBufferRef.current ?? []
        historyBufferRef.current = null
        eventBufferRef.current = []
        setEvents(appendUniqueEvents([], history))
        return
      }

      if (handlingMode === 'history') {
        // Do not bind turns or update sending/permission from replay. This
        // also protects legacy raw history events, which lack `replayed`.
        historyBufferRef.current?.push(event)
        return
      }

      const activeRequest = activeRequestRef.current
      const drivesActiveRequest =
        activeRequest === null ||
        eventBelongsToActiveRequest(event, activeRequest)
      const requestStateUpdate = getRequestStateUpdateForActiveRequest(
        event,
        activeRequest,
      )
      if (activeRequest && drivesActiveRequest) {
        activeRequestRef.current = observeActiveRequestTurn(
          activeRequest,
          event,
        )
      }

      if (event.type === 'turn_state') {
        applyRequestStateUpdate(requestStateUpdate)
        return
      }

      applyRequestStateUpdate(requestStateUpdate)

      enqueueEvent(event)
    },
    [
      applyRequestStateUpdate,
      clearBufferedEvents,
      clearEventFlushTimer,
      enqueueEvent,
      sessionClient,
    ],
  )

  React.useEffect(() => {
    if (!sessionClient) return undefined
    return sessionClient.subscribeEvents(handleEvent)
  }, [handleEvent, sessionClient])

  React.useEffect(() => {
    clearBufferedEvents()
    sessionRefreshEpochRef.current += 1
    selectionEpochRef.current += 1
    setSessions([])
    selectedSessionIdRef.current = null
    activeRequestRef.current = null
    setSelectedSessionId(null)
    setEvents([])
    setPermissionRequest(null)
    setSending(false)
    setFailedPrompt(null)
    inputRef.current = ''
    pastedTextCounterRef.current = 1
    pastedTextSegmentsRef.current = []
    setInput('')
    void refreshSessions()
  }, [args.client, args.resetKey, clearBufferedEvents, refreshSessions])

  React.useEffect(() => {
    return () => {
      clearBufferedEvents()
    }
  }, [clearBufferedEvents])

  const startNewSession = React.useCallback(() => {
    if (sending) return
    if (!sessionClient) {
      onNewSession()
      return
    }

    const epoch = ++selectionEpochRef.current
    clearBufferedEvents()
    selectedSessionIdRef.current = null
    activeRequestRef.current = null
    setSelectedSessionId(null)
    setEvents([])
    setPermissionRequest(null)
    setSending(false)
    setFailedPrompt(null)

    void sessionClient.startSession().catch(error => {
      if (selectionEpochRef.current !== epoch) return
      setEvents([createErrorLogEvent(error)])
    })
  }, [clearBufferedEvents, onNewSession, sending, sessionClient])

  const selectSession = React.useCallback(
    async (id: string) => {
      if (!args.client || sending) return
      const epoch = ++selectionEpochRef.current
      clearBufferedEvents()
      selectedSessionIdRef.current = id
      activeRequestRef.current = null
      setSelectedSessionId(id)
      setEvents([])
      setPermissionRequest(null)
      setSending(false)
      setFailedPrompt(null)

      try {
        if (sessionClient) {
          await sessionClient.attachSession(id)
        } else {
          const loaded = await args.client.loadSession(id)
          if (selectionEpochRef.current === epoch) {
            setEvents(loaded.events ?? [])
          }
        }
      } catch (error) {
        if (selectionEpochRef.current === epoch) {
          clearBufferedEvents()
          setEvents([createErrorLogEvent(error)])
        }
      } finally {
        if (selectionEpochRef.current === epoch) void refreshSessions()
      }
    },
    [args.client, clearBufferedEvents, refreshSessions, sending, sessionClient],
  )

  const clearPermissionRequest = React.useCallback(
    () => setPermissionRequest(null),
    [],
  )

  const cancel = React.useCallback(() => {
    args.client?.cancelRequest()
  }, [args.client])

  const setInputValue = React.useCallback((value: string) => {
    inputRef.current = value
    pastedTextSegmentsRef.current = retainReferencedWebPastedTextSegments({
      input: value,
      pastedTexts: pastedTextSegmentsRef.current,
    })
    setInput(value)
  }, [])

  const insertPastedText = React.useCallback(
    (paste: {
      text: string
      selectionStart: number | null
      selectionEnd: number | null
    }) => {
      const result = insertWebPastedTextPlaceholder({
        input: inputRef.current,
        text: paste.text,
        id: pastedTextCounterRef.current,
        selectionStart: paste.selectionStart,
        selectionEnd: paste.selectionEnd,
      })
      pastedTextCounterRef.current += 1
      inputRef.current = result.input
      pastedTextSegmentsRef.current = [
        ...retainReferencedWebPastedTextSegments({
          input: result.input,
          pastedTexts: pastedTextSegmentsRef.current,
        }),
        result.segment,
      ]
      setInput(result.input)
      return { cursorOffset: result.cursorOffset }
    },
    [],
  )

  const send = React.useCallback(async () => {
    const text = expandWebPastedTextPlaceholders({
      input: inputRef.current,
      pastedTexts: pastedTextSegmentsRef.current,
    }).trim()
    if (!text || !args.client || sending) return

    const sendEpoch = selectionEpochRef.current
    const sendSessionId = sessionClient?.getAttachedSessionId() ?? null
    const clientMessageUuid = createClientMessageUuid()
    const activeRequest: ActiveRequestCorrelation = {
      clientMessageUuid,
      turnId: null,
    }
    const isCurrentSelection = () =>
      selectionEpochRef.current === sendEpoch &&
      (sendSessionId === null ||
        sessionClient?.getAttachedSessionId() === sendSessionId)

    inputRef.current = ''
    pastedTextSegmentsRef.current = []
    setInput('')
    setSending(true)
    setPermissionRequest(null)
    setFailedPrompt(null)
    activeRequestRef.current = activeRequest

    const receivesPersistentEvents = Boolean(sessionClient)

    try {
      for await (const ev of args.client.sendMessage(text, {
        clientMessageUuid,
      })) {
        if (!isCurrentSelection()) continue

        const currentActiveRequest = activeRequestRef.current
        if (
          !currentActiveRequest ||
          currentActiveRequest.clientMessageUuid !== clientMessageUuid ||
          !eventBelongsToActiveRequest(ev, currentActiveRequest)
        ) {
          continue
        }
        activeRequestRef.current = observeActiveRequestTurn(
          currentActiveRequest,
          ev,
        )
        applyRequestStateUpdate(getRequestStateUpdate(ev))

        if (ev.type === 'result' && ev.is_error) {
          setFailedPrompt(text)
        }

        if (receivesPersistentEvents) continue
        if (isPermissionRequest(ev)) {
          enqueueEvent(ev)
          continue
        }
        if (ev.type === 'history_begin' || ev.type === 'history_end') continue
        enqueueEvent(ev)
      }
    } catch (error) {
      if (isCurrentSelection()) {
        setFailedPrompt(text)
        enqueueEvent(createErrorLogEvent(error))
      }
    } finally {
      if (activeRequestRef.current?.clientMessageUuid === clientMessageUuid) {
        activeRequestRef.current = null
      }
      if (isCurrentSelection()) {
        flushBufferedEvents()
        setSending(false)
        void refreshSessions()
      }
    }
  }, [
    applyRequestStateUpdate,
    args.client,
    enqueueEvent,
    flushBufferedEvents,
    refreshSessions,
    sending,
    sessionClient,
  ])

  const restoreFailedPrompt = React.useCallback(() => {
    if (sending || !failedPrompt) return
    inputRef.current = failedPrompt
    pastedTextSegmentsRef.current = []
    setInput(failedPrompt)
    setFailedPrompt(null)
  }, [failedPrompt, sending])

  return {
    sessions,
    selectedSessionId,
    events,
    permissionRequest,
    input,
    failedPrompt,
    setInput: setInputValue,
    insertPastedText,
    sending,
    send,
    cancel,
    restoreFailedPrompt,
    startNewSession,
    selectSession,
    clearPermissionRequest,
  }
}

export const __useChatForTests = {
  appendUniqueEvent,
  appendUniqueEvents,
  createErrorLogEvent,
  eventBelongsToActiveRequest,
  getEventHandlingMode,
  getEventSessionId,
  getEventRequestCorrelation,
  getRequestStateUpdate,
  getRequestStateUpdateForActiveRequest,
  getTurnStateSending,
  observeActiveRequestTurn,
}
