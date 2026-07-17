import { afterEach, describe, expect, test } from 'bun:test'

import {
  bindAiDebug,
  debug,
  getCurrentRequest,
  logAPIError,
  logLLMInteraction,
} from './debug'

afterEach(() => {
  bindAiDebug(null)
})

describe('ai internal debug sink', () => {
  test('is a no-op until bound and then forwards host sinks', () => {
    expect(getCurrentRequest()).toBeNull()
    // Unbound: must not throw.
    debug.api('UNBOUND', { ok: true })
    logAPIError({
      model: 'm',
      endpoint: '/v1',
      status: 500,
      error: 'boom',
    })

    const seen: string[] = []
    bindAiDebug({
      debug: {
        api: phase => {
          seen.push(`api:${phase}`)
        },
        error: phase => {
          seen.push(`error:${phase}`)
        },
      },
      getCurrentRequest: () => ({ id: 'req-1' }),
      logAPIError: () => {
        seen.push('api-error')
      },
      logLLMInteraction: () => {
        seen.push('llm')
      },
    })

    expect(getCurrentRequest()).toEqual({ id: 'req-1' })
    debug.api('OPENAI_CALL')
    logAPIError({
      model: 'm',
      endpoint: '/v1',
      status: 429,
      error: 'rate',
    })
    logLLMInteraction({ ok: true })
    expect(seen).toEqual(['api:OPENAI_CALL', 'api-error', 'llm'])
  })
})
