import { describe, expect, test } from 'bun:test'
import { abortableDelay } from '#core/ai/openai/retry'

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

describe('OpenAI-compatible retry abortableDelay', () => {
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

  test('aborting during the delay rejects without leaking the listener', async () => {
    const { signal, listeners } = makeSignalSpy()

    const pending = abortableDelay(10_000, signal as unknown as AbortSignal)
    const abortHandlers = listeners.get('abort') ?? []
    expect(abortHandlers).toHaveLength(1)
    abortHandlers[0]!()

    await expect(pending).rejects.toThrow('Request was aborted')
  })
})
