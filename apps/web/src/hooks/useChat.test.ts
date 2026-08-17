import { describe, expect, test } from 'bun:test'

import { __useChatForTests } from './useChat'

describe('useChat helpers', () => {
  test('creates visible log events for caught errors', () => {
    expect(
      __useChatForTests.createErrorLogEvent(new Error('socket closed')),
    ).toEqual({
      type: 'log',
      log: {
        level: 'error',
        message: 'socket closed',
      },
    })
  })

  test('routes SDK and history events to their owning session', () => {
    expect(
      __useChatForTests.getEventSessionId({
        type: 'history_begin',
        sessionId: 'session-a',
      }),
    ).toBe('session-a')

    expect(
      __useChatForTests.getEventSessionId({
        type: 'user',
        session_id: 'session-b',
        message: { role: 'user', content: 'hello' },
      }),
    ).toBe('session-b')

    expect(
      __useChatForTests.getEventSessionId({
        type: 'permission_request',
        request_id: 'permission-a',
        tool_name: 'Bash',
        tool_description: 'run a command',
        input: {},
        sessionId: 'session-c',
        clientMessageUuid: '11111111-1111-4111-8111-111111111111',
        turnId: 'turn-c',
        sequence: 3,
        replayed: false,
      }),
    ).toBe('session-c')
  })

  test('deduplicates replayed events with stable UUIDs', () => {
    const event = {
      type: 'user' as const,
      session_id: 'session-a',
      uuid: 'event-1',
      message: { role: 'user' as const, content: 'hello' },
    }

    const once = __useChatForTests.appendUniqueEvent([], event)
    const twice = __useChatForTests.appendUniqueEvent(once, event)

    expect(once).toHaveLength(1)
    expect(twice).toHaveLength(1)
  })

  test('coalesces a buffered event batch without allocating for duplicates', () => {
    const first = {
      type: 'user' as const,
      uuid: 'event-1',
      message: { role: 'user' as const, content: 'first' },
    }
    const second = {
      type: 'user' as const,
      uuid: 'event-2',
      message: { role: 'user' as const, content: 'second' },
    }

    const initial = [first]
    const merged = __useChatForTests.appendUniqueEvents(initial, [
      first,
      second,
      second,
    ])

    expect(merged).toEqual([first, second])
    expect(__useChatForTests.appendUniqueEvents(merged, [first, second])).toBe(
      merged,
    )
  })

  test('maps authoritative turn state to the sending indicator', () => {
    expect(
      __useChatForTests.getTurnStateSending({
        type: 'turn_state',
        session_id: 'session-a',
        state: 'running',
      }),
    ).toBe(true)
    expect(
      __useChatForTests.getTurnStateSending({
        type: 'turn_state',
        session_id: 'session-a',
        state: 'idle',
      }),
    ).toBe(false)
  })

  test('treats every framed history payload as transcript-only', () => {
    const legacyUser = {
      type: 'user' as const,
      session_id: 'session-a',
      uuid: 'history-user',
      message: { role: 'user' as const, content: 'earlier prompt' },
    }
    const envelopedResult = {
      type: 'result' as const,
      subtype: 'success' as const,
      result: 'earlier result',
      num_turns: 1,
      total_cost_usd: 0,
      duration_ms: 1,
      duration_api_ms: 0,
      is_error: false,
      session_id: 'session-a',
      sessionId: 'session-a',
      clientMessageUuid: 'client-a',
      turnId: 'turn-a',
      sequence: 2,
      replayed: true,
    }

    expect(__useChatForTests.getEventHandlingMode(legacyUser, true)).toBe(
      'history',
    )
    expect(__useChatForTests.getEventHandlingMode(envelopedResult, true)).toBe(
      'history',
    )
    expect(__useChatForTests.getEventHandlingMode(legacyUser, false)).toBe(
      'live',
    )
  })

  test('keeps explicitly foreign user and result events out of active request state', () => {
    const activeRequest = {
      clientMessageUuid: 'client-a',
      turnId: 'turn-a',
    }
    const foreignUser = {
      type: 'user' as const,
      session_id: 'session-a',
      uuid: 'user-b',
      clientMessageUuid: 'client-b',
      turnId: 'turn-b',
      message: { role: 'user' as const, content: 'another client prompt' },
    }
    const foreignResult = {
      type: 'result' as const,
      subtype: 'success' as const,
      result: 'another client result',
      num_turns: 1,
      total_cost_usd: 0,
      duration_ms: 1,
      duration_api_ms: 0,
      is_error: false,
      session_id: 'session-a',
      clientMessageUuid: 'client-b',
      turnId: 'turn-b',
    }

    expect(
      __useChatForTests.eventBelongsToActiveRequest(foreignUser, activeRequest),
    ).toBe(false)
    expect(
      __useChatForTests.eventBelongsToActiveRequest(
        foreignResult,
        activeRequest,
      ),
    ).toBe(false)
    expect(
      __useChatForTests.getRequestStateUpdateForActiveRequest(
        foreignUser,
        activeRequest,
      ),
    ).toBeNull()
    expect(
      __useChatForTests.getRequestStateUpdateForActiveRequest(
        foreignResult,
        activeRequest,
      ),
    ).toBeNull()
    expect(
      __useChatForTests.getRequestStateUpdateForActiveRequest(
        {
          ...foreignResult,
          sessionId: 'session-a',
          sequence: 5,
          replayed: false,
        },
        null,
      ),
    ).toBeNull()
  })

  test('binds the active turn from the matching user event and accepts its result', () => {
    const activeRequest = {
      clientMessageUuid: 'client-a',
      turnId: null as string | null,
    }
    const matchingUser = {
      type: 'user' as const,
      session_id: 'session-a',
      uuid: 'user-a',
      clientMessageUuid: 'client-a',
      turnId: 'turn-a',
      message: { role: 'user' as const, content: 'my prompt' },
    }
    const matchingResult = {
      type: 'result' as const,
      subtype: 'success' as const,
      result: 'my result',
      num_turns: 1,
      total_cost_usd: 0,
      duration_ms: 1,
      duration_api_ms: 0,
      is_error: false,
      session_id: 'session-a',
      turnId: 'turn-a',
    }

    const observedRequest = __useChatForTests.observeActiveRequestTurn(
      activeRequest,
      matchingUser,
    )

    expect(observedRequest).toEqual({
      clientMessageUuid: 'client-a',
      turnId: 'turn-a',
    })
    expect(
      __useChatForTests.eventBelongsToActiveRequest(
        matchingResult,
        observedRequest,
      ),
    ).toBe(true)
    expect(
      __useChatForTests.getRequestStateUpdateForActiveRequest(
        matchingResult,
        observedRequest,
      ),
    ).toEqual({ sending: false, permission: null })
  })

  test('preserves legacy events without metadata but excludes replayed events', () => {
    const activeRequest = {
      clientMessageUuid: 'client-a',
      turnId: 'turn-a',
    }
    const legacyResult = {
      type: 'result' as const,
      subtype: 'success' as const,
      result: 'legacy result',
      num_turns: 1,
      total_cost_usd: 0,
      duration_ms: 1,
      duration_api_ms: 0,
      is_error: false,
      session_id: 'session-a',
    }
    const replayedResult = {
      ...legacyResult,
      clientMessageUuid: 'client-a',
      turnId: 'turn-a',
      replayed: true,
    }
    const unscopedDaemonResult = {
      ...legacyResult,
      sessionId: 'session-a',
      clientMessageUuid: null as string | null,
      turnId: null as string | null,
      sequence: 42,
      replayed: false,
    }

    expect(
      __useChatForTests.eventBelongsToActiveRequest(
        legacyResult,
        activeRequest,
      ),
    ).toBe(true)
    expect(
      __useChatForTests.getRequestStateUpdateForActiveRequest(
        legacyResult,
        activeRequest,
      ),
    ).toEqual({ sending: false, permission: null })
    expect(
      __useChatForTests.eventBelongsToActiveRequest(
        replayedResult,
        activeRequest,
      ),
    ).toBe(false)
    expect(
      __useChatForTests.eventBelongsToActiveRequest(
        unscopedDaemonResult,
        activeRequest,
      ),
    ).toBe(false)
  })
})
