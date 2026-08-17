import { describe, expect, test } from 'bun:test'

import { createKodeDaemonClient } from '#daemon/client'
import { startKodeDaemon } from '#daemon/server'

describe('daemon client SDK', () => {
  test('connects, sends prompt, and yields AgentEvents (echo)', async () => {
    const daemon = await startKodeDaemon({
      cwd: process.cwd(),
      port: 0,
      echo: true,
    })

    const client = createKodeDaemonClient({ url: daemon.url })

    try {
      await client.connect({ timeoutMs: 5_000 })

      client.sendPrompt('hello')

      const events: any[] = []
      await Promise.race([
        (async () => {
          for await (const ev of client.events) {
            events.push(ev)
            if (ev && ev.type === 'result') break
          }
        })(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 5_000),
        ),
      ])

      expect(
        events.some(e => e && e.type === 'system' && e.subtype === 'init'),
      ).toBe(true)
      expect(events.some(e => e && e.type === 'user')).toBe(true)

      const assistant = events.find(e => e && e.type === 'assistant')
      expect(assistant).toBeDefined()

      const result = events.find(e => e && e.type === 'result')
      expect(result).toBeDefined()
      expect(result.result).toBe('hello')
      expect(result.is_error).toBe(false)
    } finally {
      try {
        client.close()
      } catch {
        /* no-op */
      }
      daemon.stop()
    }
  }, 20_000)
})
