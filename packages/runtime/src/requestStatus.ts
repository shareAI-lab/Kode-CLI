export type RequestStatusKind =
  'idle' | 'waiting' | 'thinking' | 'streaming' | 'tool'

export type RequestStatus = {
  kind: RequestStatusKind
  detail?: string
  updatedAt: number
  /** When the current request began; stable across thinking, tools, and text. */
  startedAt?: number
  /** When the current visible phase began. */
  phaseStartedAt?: number
  inputTokens?: number
  outputTokens?: number
  /** Completed Thinking phases; an active phase is added by getRequestStatusTiming. */
  thinkingDurationMs?: number
}

let current: RequestStatus = { kind: 'idle', updatedAt: Date.now() }
const listeners = new Set<(status: RequestStatus) => void>()
const TOKEN_NOTIFICATION_INTERVAL_MS = 200
let tokenNotificationTimer: ReturnType<typeof setTimeout> | null = null
let lastTokenNotificationAt = 0

function notifyListeners(): void {
  for (const listener of listeners) listener(current)
}

function clearTokenNotificationTimer(): void {
  if (!tokenNotificationTimer) return
  clearTimeout(tokenNotificationTimer)
  tokenNotificationTimer = null
}

function notifyTokenListenersThrottled(): void {
  const now = Date.now()
  const elapsed = now - lastTokenNotificationAt
  if (
    lastTokenNotificationAt === 0 ||
    elapsed >= TOKEN_NOTIFICATION_INTERVAL_MS
  ) {
    clearTokenNotificationTimer()
    lastTokenNotificationAt = now
    notifyListeners()
    return
  }

  if (tokenNotificationTimer) return
  tokenNotificationTimer = setTimeout(() => {
    tokenNotificationTimer = null
    lastTokenNotificationAt = Date.now()
    notifyListeners()
  }, TOKEN_NOTIFICATION_INTERVAL_MS - elapsed)
}

export function getRequestStatus(): RequestStatus {
  return current
}

export function getRequestStatusTiming(
  status: RequestStatus,
  now = Date.now(),
): {
  requestDurationMs: number
  phaseDurationMs: number
  thinkingDurationMs: number
} {
  if (status.kind === 'idle') {
    return {
      requestDurationMs: 0,
      phaseDurationMs: 0,
      thinkingDurationMs: 0,
    }
  }

  const startedAt = status.startedAt ?? status.updatedAt
  const phaseStartedAt = status.phaseStartedAt ?? status.updatedAt
  const requestDurationMs = Math.max(0, now - startedAt)
  const phaseDurationMs = Math.max(0, now - phaseStartedAt)
  const thinkingDurationMs =
    (status.thinkingDurationMs ?? 0) +
    (status.kind === 'thinking' ? phaseDurationMs : 0)

  return { requestDurationMs, phaseDurationMs, thinkingDurationMs }
}

export function setRequestStatus(
  status: Omit<RequestStatus, 'updatedAt'>,
): void {
  clearTokenNotificationTimer()
  const now = Date.now()
  if (status.kind === 'idle') {
    lastTokenNotificationAt = 0
    // Preserve final token counts for the terminal subscriber notification.
    // A subsequent non-idle status starts a fresh request and clears them.
    current = {
      ...current,
      kind: 'idle',
      detail: undefined,
      startedAt: undefined,
      phaseStartedAt: undefined,
      thinkingDurationMs: undefined,
      updatedAt: now,
    }
    notifyListeners()
    return
  }

  const isNewRequest = current.kind === 'idle'
  const phaseChanged = isNewRequest || current.kind !== status.kind
  const completedThinkingDurationMs =
    (current.thinkingDurationMs ?? 0) +
    (current.kind === 'thinking' && phaseChanged
      ? Math.max(0, now - (current.phaseStartedAt ?? current.updatedAt))
      : 0)
  const hasDetail = Object.prototype.hasOwnProperty.call(status, 'detail')
  const hasInputTokens = Object.prototype.hasOwnProperty.call(
    status,
    'inputTokens',
  )
  const hasOutputTokens = Object.prototype.hasOwnProperty.call(
    status,
    'outputTokens',
  )

  current = {
    ...current,
    ...status,
    // A phase must not inherit a stale tool name or command-specific status.
    detail: hasDetail
      ? status.detail
      : phaseChanged
        ? undefined
        : current.detail,
    inputTokens: hasInputTokens
      ? status.inputTokens
      : isNewRequest
        ? undefined
        : current.inputTokens,
    outputTokens: hasOutputTokens
      ? status.outputTokens
      : isNewRequest || (phaseChanged && status.kind === 'streaming')
        ? undefined
        : current.outputTokens,
    startedAt: isNewRequest ? now : (current.startedAt ?? now),
    phaseStartedAt: phaseChanged ? now : (current.phaseStartedAt ?? now),
    thinkingDurationMs: completedThinkingDurationMs,
    updatedAt: now,
  }
  notifyListeners()
}

export function setRequestInputTokens(inputTokens: number): void {
  if (current.kind !== 'idle') {
    clearTokenNotificationTimer()
    current = {
      ...current,
      inputTokens,
      outputTokens: undefined,
      updatedAt: Date.now(),
    }
    notifyListeners()
  }
}

export function updateRequestTokens(outputTokens: number): void {
  if (current.kind !== 'idle') {
    current = { ...current, outputTokens, updatedAt: Date.now() }
    notifyTokenListenersThrottled()
  }
}

export function subscribeRequestStatus(
  listener: (status: RequestStatus) => void,
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// ---------------------------------------------------------------------------
// Shared display helpers.
//
// Both the main REPL indicator (RequestStatusIndicator) and the Bash
// background overlay render the same request status. Keeping the wording and
// formatting here guarantees the two views can never drift apart again.
// ---------------------------------------------------------------------------

/** After this many seconds without a first response, wording escalates. */
export const FIRST_RESPONSE_WARNING_SECONDS = 15

/** Shared "cancel" affordance text shown next to a running request. */
export const REQUEST_STATUS_ESC_CANCEL_HINT = '(Esc to cancel)'

/** Formats a whole number of seconds as "5s", "2m 3s", "1h 2m 3s". */
export function formatRequestStatusDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds))
  if (safe < 60) return `${safe}s`
  if (safe < 3600) {
    const minutes = Math.floor(safe / 60)
    const secs = safe % 60
    return `${minutes}m ${secs}s`
  }
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const secs = safe % 60
  return `${hours}h ${minutes}m ${secs}s`
}

/**
 * Compact token count ("12k", "1.5M"). Uses the same rounding as the UI
 * tokenDisplay helper so every view reports the same number.
 */
export function formatRequestStatusTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0'
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return `${Math.round(tokens)}`
}

/** Plain-language label for the current request phase. */
export function getRequestStatusLabel(
  status: RequestStatus,
  elapsedSeconds: number,
): string {
  switch (status.kind) {
    case 'waiting': {
      const detail = status.detail?.trim()
      if (!detail) {
        return 'Waiting for model response'
      }
      return elapsedSeconds >= FIRST_RESPONSE_WARNING_SECONDS
        ? `${detail} · waiting for first model response`
        : detail
    }
    case 'thinking':
      return 'Thinking'
    case 'streaming':
      return 'Writing response'
    case 'tool': {
      const detail = status.detail?.trim()
      return detail ? `Working · ${detail}` : 'Working · running tool'
    }
    case 'idle':
      return ''
  }
}

/** Live token counters shown next to the status label. */
export function getRequestStatusTokenDisplay(status: RequestStatus): string {
  if (
    (status.kind === 'waiting' || status.kind === 'thinking') &&
    status.inputTokens
  ) {
    return ` · ↑ ${formatRequestStatusTokens(status.inputTokens)}`
  }
  if (status.kind === 'streaming' && status.outputTokens !== undefined) {
    return ` · ↓ ${formatRequestStatusTokens(status.outputTokens)}`
  }
  return ''
}

/** "waiting 3s" / "thinking 2s" / "writing 1s" / "working 5s" phase label. */
export function getRequestStatusPhaseLabel(
  status: RequestStatus,
  now: number,
): string {
  const timing = getRequestStatusTiming(status, now)
  switch (status.kind) {
    case 'waiting':
      return `waiting ${formatRequestStatusDuration(
        Math.floor(timing.phaseDurationMs / 1000),
      )}`
    case 'thinking':
      return `thinking ${formatRequestStatusDuration(
        Math.floor(timing.thinkingDurationMs / 1000),
      )}`
    case 'streaming':
      return `writing ${formatRequestStatusDuration(
        Math.floor(timing.phaseDurationMs / 1000),
      )}`
    case 'tool':
      return `working ${formatRequestStatusDuration(
        Math.floor(timing.phaseDurationMs / 1000),
      )}`
    case 'idle':
      return ''
  }
}

/** Hide the phase chip when it only restates the main label or matches total time. */
export function shouldShowRequestStatusPhase(
  status: RequestStatus,
  now: number,
): boolean {
  if (status.kind === 'idle' || status.kind === 'waiting') return false

  const timing = getRequestStatusTiming(status, now)
  const phaseMs =
    status.kind === 'thinking'
      ? timing.thinkingDurationMs
      : timing.phaseDurationMs
  return phaseMs + 1000 < timing.requestDurationMs
}
