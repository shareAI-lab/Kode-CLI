/**
 * Host-agnostic debug surface for @kode/ai.
 *
 * Default sinks are no-ops so this package does not hard-depend on core
 * logging. Hosts (CLI/daemon) should call `bindAiDebug` once at boot to
 * attach the real `#core` logger when full diagnostics are desired.
 */

export type AiRequestContext = {
  id: string
}

export type AiDebugLogger = {
  api: (phase: string, data?: unknown, requestId?: string) => void
  warn: (phase: string, data?: unknown, requestId?: string) => void
  error: (phase: string, data?: unknown, requestId?: string) => void
  flow: (phase: string, data?: unknown, requestId?: string) => void
  info: (phase: string, data?: unknown, requestId?: string) => void
  state: (phase: string, data?: unknown, requestId?: string) => void
}

export type AiApiErrorContext = {
  model: string
  endpoint: string
  status: number
  error: unknown
  request?: unknown
  response?: unknown
  provider?: string
}

export type AiDebugBindings = {
  debug?: Partial<AiDebugLogger>
  getCurrentRequest?: () => AiRequestContext | null
  logAPIError?: (context: AiApiErrorContext) => void
  logLLMInteraction?: (context: unknown) => void
  logSystemPromptConstruction?: (context: unknown) => void
}

const noop = (_phase: string, _data?: unknown, _requestId?: string) => {}

const defaultLogger: AiDebugLogger = {
  api: noop,
  warn: noop,
  error: noop,
  flow: noop,
  info: noop,
  state: noop,
}

let logger: AiDebugLogger = { ...defaultLogger }
let requestProvider: (() => AiRequestContext | null) | null = null
let apiErrorLogger: ((context: AiApiErrorContext) => void) | null = null
let llmInteractionLogger: ((context: unknown) => void) | null = null
let systemPromptLogger: ((context: unknown) => void) | null = null

export function bindAiDebug(
  bindings: AiDebugBindings | null | undefined,
): void {
  if (!bindings) {
    logger = { ...defaultLogger }
    requestProvider = null
    apiErrorLogger = null
    llmInteractionLogger = null
    systemPromptLogger = null
    return
  }
  logger = {
    api: bindings.debug?.api ?? noop,
    warn: bindings.debug?.warn ?? noop,
    error: bindings.debug?.error ?? noop,
    flow: bindings.debug?.flow ?? noop,
    info: bindings.debug?.info ?? noop,
    state: bindings.debug?.state ?? noop,
  }
  requestProvider = bindings.getCurrentRequest ?? null
  apiErrorLogger = bindings.logAPIError ?? null
  llmInteractionLogger = bindings.logLLMInteraction ?? null
  systemPromptLogger = bindings.logSystemPromptConstruction ?? null
}

/** Compatibility shape used by OpenAI provider modules. */
export const debug = {
  api: (phase: string, data?: unknown, requestId?: string) =>
    logger.api(phase, data, requestId),
  warn: (phase: string, data?: unknown, requestId?: string) =>
    logger.warn(phase, data, requestId),
  error: (phase: string, data?: unknown, requestId?: string) =>
    logger.error(phase, data, requestId),
  flow: (phase: string, data?: unknown, requestId?: string) =>
    logger.flow(phase, data, requestId),
  info: (phase: string, data?: unknown, requestId?: string) =>
    logger.info(phase, data, requestId),
  state: (phase: string, data?: unknown, requestId?: string) =>
    logger.state(phase, data, requestId),
}

export function getCurrentRequest(): AiRequestContext | null {
  try {
    return requestProvider?.() ?? null
  } catch {
    return null
  }
}

export function logAPIError(context: AiApiErrorContext): void {
  if (apiErrorLogger) {
    try {
      apiErrorLogger(context)
      return
    } catch {
      // Fall through to local debug sink.
    }
  }
  logger.error('API_ERROR', {
    model: context.model,
    endpoint: context.endpoint,
    status: context.status,
    provider: context.provider,
    error:
      context.error instanceof Error
        ? context.error.message
        : typeof context.error === 'string'
          ? context.error
          : 'Unknown error',
  })
}

export function logLLMInteraction(context: unknown): void {
  try {
    llmInteractionLogger?.(context)
  } catch {
    // Host diagnostics must never break model transport.
  }
}

export function logSystemPromptConstruction(context: unknown): void {
  try {
    systemPromptLogger?.(context)
  } catch {
    // Host diagnostics must never break model transport.
  }
}
