export type TimeoutSignal = { signal: AbortSignal; cleanup: () => void }

export function createTimeoutSignal(timeoutMs: number): TimeoutSignal {
  if (typeof AbortSignal.timeout === 'function') {
    return { signal: AbortSignal.timeout(timeoutMs), cleanup: () => {} }
  }

  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeoutMs)
  return { signal: controller.signal, cleanup: () => clearTimeout(id) }
}

export function mergeAbortSignals(
  signals: Array<AbortSignal | undefined>,
): TimeoutSignal | null {
  const active = signals.filter((s): s is AbortSignal => !!s)
  if (active.length === 0) return null
  if (active.length === 1) return { signal: active[0]!, cleanup: () => {} }

  const controller = new AbortController()
  const unsubscribers: Array<() => void> = []

  const abort = () => {
    try {
      controller.abort()
    } catch {
      /* no-op */
    }
  }

  for (const signal of active) {
    if (signal.aborted) {
      abort()
      return { signal: controller.signal, cleanup: () => {} }
    }
    signal.addEventListener('abort', abort, { once: true })
    unsubscribers.push(() => {
      try {
        signal.removeEventListener('abort', abort)
      } catch {
        /* no-op */
      }
    })
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      for (const unsubscribe of unsubscribers) unsubscribe()
    },
  }
}
