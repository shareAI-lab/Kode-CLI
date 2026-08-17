import { describe, expect, spyOn, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'
import { withRetry } from '#core/ai/llm/retry'

type TimerCallback = (...args: unknown[]) => void

describe('LLM retry', () => {
  test('uses Retry-After from Headers for a retried API error', async () => {
    const delays: number[] = []
    const immediateSetTimeout = (
      callback: TimerCallback | string,
      delay?: number,
      ...args: unknown[]
    ) => {
      delays.push(Number(delay ?? 0))
      if (typeof callback === 'function') {
        queueMicrotask(() => Reflect.apply(callback, undefined, args))
      }
      return 0 as unknown as ReturnType<typeof setTimeout>
    }
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      immediateSetTimeout as unknown as typeof setTimeout,
    )
    const rateLimitError = new APIError(
      429,
      { error: { type: 'rate_limit_error' } },
      'Rate limited',
      new Headers({ 'retry-after': '3' }),
    )
    let attempts = 0

    try {
      const result = await withRetry(
        async () => {
          attempts += 1
          if (attempts === 1) throw rateLimitError
          return 'retried'
        },
        { maxRetries: 1 },
      )

      expect(result).toBe('retried')
      expect(attempts).toBe(2)
      expect(delays).toEqual([3000])
    } finally {
      setTimeoutSpy.mockRestore()
    }
  })

  test('bounds malformed or excessive Retry-After values before retrying', async () => {
    const delays: number[] = []
    const immediateSetTimeout = (
      callback: TimerCallback | string,
      delay?: number,
      ...args: unknown[]
    ) => {
      delays.push(Number(delay ?? 0))
      if (typeof callback === 'function') {
        queueMicrotask(() => Reflect.apply(callback, undefined, args))
      }
      return 0 as unknown as ReturnType<typeof setTimeout>
    }
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      immediateSetTimeout as unknown as typeof setTimeout,
    )

    try {
      for (const retryAfter of ['3600', '-1']) {
        const error = new APIError(
          429,
          { error: { type: 'rate_limit_error' } },
          'Rate limited',
          new Headers({ 'retry-after': retryAfter }),
        )
        let attempts = 0
        await withRetry(
          async () => {
            attempts += 1
            if (attempts === 1) throw error
            return 'retried'
          },
          { maxRetries: 1 },
        )
      }

      expect(delays).toEqual([60_000, 500])
    } finally {
      setTimeoutSpy.mockRestore()
    }
  })
})
