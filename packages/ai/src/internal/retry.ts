import { APIConnectionError, APIError } from '@anthropic-ai/sdk'

import { debug as debugLogger } from './debug'

const MAX_RETRIES = process.env.USER_TYPE === 'SWE_BENCH' ? 100 : 10
const BASE_DELAY_MS = 500

interface RetryOptions {
  maxRetries?: number
  signal?: AbortSignal
}

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Request was aborted'))
      return
    }

    const timeoutId = setTimeout(() => {
      resolve()
    }, delayMs)

    if (signal) {
      const abortHandler = () => {
        clearTimeout(timeoutId)
        reject(new Error('Request was aborted'))
      }
      signal.addEventListener('abort', abortHandler, { once: true })
    }
  })
}

function getRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
): number {
  if (retryAfterHeader) {
    const seconds = Number.parseInt(retryAfterHeader, 10)
    if (!Number.isNaN(seconds)) {
      return seconds * 1000
    }
  }
  return Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), 32000)
}

function shouldRetry(error: APIError): boolean {
  if (error.message?.includes('"type":"overloaded_error"')) {
    return process.env.USER_TYPE === 'SWE_BENCH'
  }

  const shouldRetryHeader = error.headers?.['x-should-retry']

  if (shouldRetryHeader === 'true') return true
  if (shouldRetryHeader === 'false') return false

  if (error instanceof APIConnectionError) {
    return true
  }

  if (!error.status) return false

  if (error.status === 408) return true
  if (error.status === 409) return true
  if (error.status === 429) return true
  if (error.status && error.status >= 500) return true

  return false
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? MAX_RETRIES
  let lastError: unknown

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await operation(attempt)
    } catch (error) {
      lastError = error
      if (
        attempt > maxRetries ||
        !(error instanceof APIError) ||
        !shouldRetry(error)
      ) {
        throw error
      }

      if (options.signal?.aborted) {
        throw new Error('Request cancelled by user')
      }

      const retryAfter = error.headers?.['retry-after'] ?? null
      const delayMs = getRetryDelay(attempt, retryAfter)

      debugLogger.warn('LLM_API_RETRY', {
        name: error.name,
        message: error.message,
        status: error.status,
        attempt,
        maxRetries,
        delayMs,
      })

      try {
        await abortableDelay(delayMs, options.signal)
      } catch (delayError) {
        if (
          delayError instanceof Error &&
          delayError.message === 'Request was aborted'
        ) {
          throw new Error('Request cancelled by user')
        }
        throw delayError
      }
    }
  }

  throw lastError
}
