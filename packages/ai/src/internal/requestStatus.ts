/**
 * Optional request-status hooks for streaming UIs.
 * Hosts may bind core requestStatus; default is no-op.
 */

export type RequestStatusBindings = {
  setRequestStatus?: (status: unknown) => void
  setRequestInputTokens?: (tokens: number) => void
  updateRequestTokens?: (tokens: number) => void
}

let setStatus: (status: unknown) => void = () => {}
let setInputTokens: (tokens: number) => void = () => {}
let updateTokens: (tokens: number) => void = () => {}

export function bindAiRequestStatus(
  bindings: RequestStatusBindings | null | undefined,
): void {
  setStatus = bindings?.setRequestStatus ?? (() => {})
  setInputTokens = bindings?.setRequestInputTokens ?? (() => {})
  updateTokens = bindings?.updateRequestTokens ?? (() => {})
}

export function setRequestStatus(status: unknown): void {
  try {
    setStatus(status)
  } catch {
    // Never break streaming for status UI.
  }
}

export function setRequestInputTokens(tokens: number): void {
  try {
    setInputTokens(tokens)
  } catch {
    // ignore
  }
}

export function updateRequestTokens(tokens: number): void {
  try {
    updateTokens(tokens)
  } catch {
    // ignore
  }
}
