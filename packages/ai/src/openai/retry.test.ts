import { describe, expect, test } from 'bun:test'

import { abortableDelay, isRetryableHttpStatus } from './retry'

describe('isRetryableHttpStatus', () => {
  test('does not retry client configuration failures', () => {
    expect(isRetryableHttpStatus(400)).toBe(false)
    expect(isRetryableHttpStatus(401)).toBe(false)
    expect(isRetryableHttpStatus(404)).toBe(false)
  })

  test('retries transient provider failures', () => {
    expect(isRetryableHttpStatus(408)).toBe(true)
    expect(isRetryableHttpStatus(409)).toBe(true)
    expect(isRetryableHttpStatus(429)).toBe(true)
    expect(isRetryableHttpStatus(500)).toBe(true)
  })
})

function makeSignalSpy() {
  const events: string[] = []
  const listeners = new Map<string, (() => void)[]>()
  const signal = {
    aborted: false,
    addEventListener(event: string, handler: () => void) {
      events.push(`add:${event}`)
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
    },
    removeEventListener(event: string, handler: () => void) {
      events.push(`remove:${event}`)
      const list = listeners.get(event) ?? []
      listeners.set(
        event,
        list.filter(candidate => candidate !== handler),
      )
    },
  }
  return { signal, events, listeners }
}

describe('abortableDelay', () => {
  test('removes its abort listener once the timer resolves', async () => {
    const { signal, events, listeners } = makeSignalSpy()

    await abortableDelay(1, signal as unknown as AbortSignal)

    expect(events).toEqual(['add:abort', 'remove:abort'])
    expect(listeners.get('abort') ?? []).toHaveLength(0)
  })

  test('rejects immediately when the signal is already aborted', async () => {
    const { signal } = makeSignalSpy()
    ;(signal as { aborted: boolean }).aborted = true

    await expect(
      abortableDelay(1, signal as unknown as AbortSignal),
    ).rejects.toThrow('Request was aborted')
  })

  test('aborting during the delay rejects without a dangling timer', async () => {
    const { signal, listeners } = makeSignalSpy()

    const pending = abortableDelay(10_000, signal as unknown as AbortSignal)
    const abortHandlers = listeners.get('abort') ?? []
    expect(abortHandlers).toHaveLength(1)
    abortHandlers[0]!()

    await expect(pending).rejects.toThrow('Request was aborted')
  })
})
