import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'crypto'

let currentSessionId: string = randomUUID()
const sessionIdScope = new AsyncLocalStorage<{ sessionId: string }>()

/** Bind a session ID to one async run without changing process-global state. */
export function runWithKodeAgentSessionId<T>(
  sessionId: string,
  callback: () => T,
): T {
  return sessionIdScope.run({ sessionId }, callback)
}

export function setKodeAgentSessionId(nextSessionId: string): void {
  const scope = sessionIdScope.getStore()
  if (scope) {
    scope.sessionId = nextSessionId
    return
  }
  currentSessionId = nextSessionId
}

export function resetKodeAgentSessionIdForTests(): void {
  currentSessionId = randomUUID()
}

export function getKodeAgentSessionId(): string {
  return sessionIdScope.getStore()?.sessionId ?? currentSessionId
}
