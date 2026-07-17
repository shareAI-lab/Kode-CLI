/**
 * Runtime knobs for provider transport without hard-depending on core config,
 * logging, or cost tracking. Hosts (CLI/daemon) call `bindAiRuntime` at boot.
 */

export type AiModelProfileLike = {
  modelName?: string
  name?: string
  provider?: string
  baseURL?: string
  apiKey?: string
  reasoningEffort?: string
  [key: string]: unknown
}

export type AiRuntimeBindings = {
  getProxy?: () => string | undefined
  /** Whether Chat Completions should stream. Default true when unbound. */
  getStream?: () => boolean
  /** Fallback model profile when callers omit `options.modelProfile`. */
  getMainModelProfile?: () => AiModelProfileLike | null | undefined
  logError?: (error: unknown) => void
  addToTotalCost?: (costUSD: number, durationMs: number) => void
}

let getProxyImpl: () => string | undefined = () => {
  const proxy =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy
  return proxy?.trim() || undefined
}

let getStreamImpl: () => boolean = () => true
let getMainModelProfileImpl: () => AiModelProfileLike | null | undefined = () =>
  null
let logErrorImpl: (error: unknown) => void = () => {}
let addToTotalCostImpl: (costUSD: number, durationMs: number) => void = () => {}

function defaultProxy(): string | undefined {
  const proxy =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy
  return proxy?.trim() || undefined
}

export function bindAiRuntime(
  bindings: AiRuntimeBindings | null | undefined,
): void {
  if (!bindings) {
    getProxyImpl = defaultProxy
    getStreamImpl = () => true
    getMainModelProfileImpl = () => null
    logErrorImpl = () => {}
    addToTotalCostImpl = () => {}
    return
  }
  getProxyImpl = bindings.getProxy ?? defaultProxy
  getStreamImpl = bindings.getStream ?? (() => true)
  getMainModelProfileImpl = bindings.getMainModelProfile ?? (() => null)
  logErrorImpl = bindings.logError ?? (() => {})
  addToTotalCostImpl = bindings.addToTotalCost ?? (() => {})
}

export function getAiProxy(): string | undefined {
  try {
    return getProxyImpl()
  } catch {
    return undefined
  }
}

export function getAiStream(): boolean {
  try {
    return getStreamImpl() !== false
  } catch {
    return true
  }
}

export function getAiMainModelProfile(): AiModelProfileLike | null {
  try {
    return getMainModelProfileImpl() ?? null
  } catch {
    return null
  }
}

export function logAiError(error: unknown): void {
  try {
    logErrorImpl(error)
  } catch {
    // Host diagnostics must never break model transport.
  }
}

export function addAiTotalCost(costUSD: number, durationMs: number): void {
  try {
    addToTotalCostImpl(costUSD, durationMs)
  } catch {
    // Host accounting must never break model transport.
  }
}
