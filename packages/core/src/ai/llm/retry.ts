import { APIConnectionError, APIError } from '@anthropic-ai/sdk'
import { OpenAIStreamError } from '#core/ai/openai/stream'
import { debug as debugLogger } from '#core/utils/debugLogger'

const MAX_RETRIES = process.env.USER_TYPE === 'SWE_BENCH' ? 100 : 10
const BASE_DELAY_MS = 500
const MAX_SERVER_RETRY_DELAY_MS = 60_000

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

function getRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
): number {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader)
    if (Number.isSafeInteger(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, MAX_SERVER_RETRY_DELAY_MS)
    }
  }
  return Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), 32000)
}

function shouldRetry(error: APIError): boolean {
  if (error.message?.includes('"type":"overloaded_error"')) {
    return process.env.USER_TYPE === 'SWE_BENCH'
  }

  const shouldRetryHeader = error.headers?.get('x-should-retry')

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

/**
 * A degraded/truncated stream is retryable: the retry loop re-issues the
 * request through the non-streaming endpoint to preserve completion integrity
 * (see queryOpenAI's `attempt > 1` fallback).
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof OpenAIStreamError) return true
  if (!(error instanceof APIError)) return false
  return shouldRetry(error)
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
        !isRetryableError(error)
      ) {
        throw error
      }

      if (options.signal?.aborted) {
        throw new Error('Request cancelled by user')
      }

      const apiError =
        error instanceof APIError
          ? error
          : error instanceof OpenAIStreamError
            ? null
            : null
      const retryAfter = apiError?.headers?.get('retry-after') ?? null
      const delayMs = getRetryDelay(attempt, retryAfter)

      debugLogger.warn('LLM_API_RETRY', {
        name: error instanceof Error ? error.name : String(error),
        message: error instanceof Error ? error.message : String(error),
        status: apiError?.status,
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
