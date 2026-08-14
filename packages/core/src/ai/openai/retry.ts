const RETRY_CONFIG = {
  BASE_DELAY_MS: 1000,
  MAX_DELAY_MS: 32000,
  MAX_SERVER_DELAY_MS: 60000,
  JITTER_FACTOR: 0.1,
} as const

/** A malformed request or credential cannot succeed on a later attempt. */
export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500
}

export function getRetryDelay(
  attempt: number,
  retryAfter?: string | null,
): number {
  if (retryAfter) {
    const retryAfterMs = parseInt(retryAfter) * 1000
    if (!isNaN(retryAfterMs) && retryAfterMs > 0) {
      return Math.min(retryAfterMs, RETRY_CONFIG.MAX_SERVER_DELAY_MS)
    }
  }

  const delay = RETRY_CONFIG.BASE_DELAY_MS * Math.pow(2, attempt - 1)
  const jitter = Math.random() * RETRY_CONFIG.JITTER_FACTOR * delay

  return Math.min(delay + jitter, RETRY_CONFIG.MAX_DELAY_MS)
}

export function abortableDelay(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Request was aborted'))
      return
    }

    let abortHandler: (() => void) | undefined
    const timeoutId = setTimeout(() => {
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler)
      }
      resolve()
    }, delayMs)

    if (signal) {
      abortHandler = () => {
        clearTimeout(timeoutId)
        reject(new Error('Request was aborted'))
      }
      signal.addEventListener('abort', abortHandler, { once: true })
    }
  })
}
