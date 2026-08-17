import { describe, expect, spyOn, test } from 'bun:test'
import { APIError } from '@anthropic-ai/sdk'

import { withRetry } from './retry'

type TimerCallback = (...args: unknown[]) => void

describe('AI package retry', () => {
  test('bounds a provider Retry-After delay', async () => {
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
      new Headers({ 'retry-after': '3600' }),
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
      expect(delays).toEqual([60_000])
    } finally {
      setTimeoutSpy.mockRestore()
    }
  })
})
