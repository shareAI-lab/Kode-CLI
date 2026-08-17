import { AsyncLocalStorage } from 'node:async_hooks'

type KodeAgentSessionForkInfo = {
  forkedFromSessionId: string
  forkRootSessionId: string
}

let currentForkInfo: KodeAgentSessionForkInfo | null = null
const forkInfoScope = new AsyncLocalStorage<{
  forkInfo: KodeAgentSessionForkInfo | null
}>()

/** Bind fork metadata to one async run without changing global session state. */
export function runWithKodeAgentSessionForkInfo<T>(
  forkInfo: KodeAgentSessionForkInfo | null,
  callback: () => T,
): T {
  return forkInfoScope.run({ forkInfo }, callback)
}

export function setKodeAgentSessionForkInfo(
  next: KodeAgentSessionForkInfo | null,
): void {
  const scope = forkInfoScope.getStore()
  if (scope) {
    scope.forkInfo = next
    return
  }
  currentForkInfo = next
}

export function getKodeAgentSessionForkInfo(): KodeAgentSessionForkInfo | null {
  return forkInfoScope.getStore()?.forkInfo ?? currentForkInfo
}

export function resetKodeAgentSessionForkInfoForTests(): void {
  currentForkInfo = null
}
