import { describe, expect, test } from 'bun:test'
import type {
  DaemonManagedAgent,
  DaemonPermissionSnapshot,
  DaemonTask,
} from '@kode/protocol'

import { HttpClient } from './http'

class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  readyState = 0
  sent: string[] = []
  private readonly listeners = new Map<string, Set<(event: any) => void>>()

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }

  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: any) => void,
    options?: { once?: boolean },
  ): void {
    const wrapped =
      options?.once === true
        ? (event: any) => {
            this.removeEventListener(type, wrapped)
            listener(event)
          }
        : listener
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(wrapped)
    this.listeners.set(type, listeners)
  }

  removeEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: any) => void,
  ): void {
    this.listeners.get(type)?.delete(listener)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
    this.emit('close', {})
  }

  open(): void {
    this.readyState = 1
    this.emit('open', {})
  }

  message(payload: unknown): void {
    this.emit('message', { data: JSON.stringify(payload) })
  }

  error(): void {
    this.emit('error', {})
  }

  private emit(type: 'open' | 'message' | 'close' | 'error', event: any): void {
    for (const listener of Array.from(this.listeners.get(type) ?? [])) {
      listener(event)
    }
  }
}

async function waitTick(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

async function waitMs(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

function initEvent(sessionId: string) {
  return {
    type: 'system' as const,
    subtype: 'init',
    session_id: sessionId,
  }
}

function userEvent(sessionId: string, text: string, uuid: string) {
  return {
    type: 'user' as const,
    session_id: sessionId,
    uuid,
    message: { role: 'user' as const, content: text },
  }
}

function completeHistory(ws: FakeWebSocket, sessionId: string): void {
  ws.message({ type: 'history_begin', sessionId })
  ws.message({ type: 'history_end', sessionId })
}

describe('HttpClient', () => {
  test('sendMessage rejects when the WebSocket closes before result', async () => {
    FakeWebSocket.instances = []
    const client = new HttpClient({
      baseUrl: 'http://localhost:32123',
      token: 'token',
      webSocketImpl: FakeWebSocket,
    })

    const iterator = client.sendMessage('hello')
    const next = iterator.next()
    const ws = FakeWebSocket.instances[0]
    expect(ws).toBeDefined()

    ws!.open()
    ws!.message(initEvent('session'))
    await waitTick()

    expect(JSON.parse(ws!.sent[0] ?? '{}')).toMatchObject({
      type: 'prompt',
      prompt: 'hello',
    })

    ws!.close()

    await expect(next).rejects.toThrow(
      'WebSocket connection closed before the response completed',
    )
    expect(client.isConnected()).toBe(false)
  })

  test('sendMessage still yields queued result before completing', async () => {
    FakeWebSocket.instances = []
    const client = new HttpClient({
      baseUrl: 'http://localhost:32123',
      token: 'token',
      webSocketImpl: FakeWebSocket,
    })

    const iterator = client.sendMessage('hello')
    const first = iterator.next()
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    ws.message(initEvent('session'))
    await waitTick()

    ws.message({
      type: 'result',
      subtype: 'success',
      result: 'ok',
      num_turns: 1,
      total_cost_usd: 0,
      duration_ms: 1,
      duration_api_ms: 0,
      is_error: false,
      session_id: 'session',
      uuid: 'result-1',
    })

    expect(await first).toMatchObject({
      done: false,
      value: { type: 'result', result: 'ok' },
    })
    expect(await iterator.next()).toMatchObject({ done: true })
  })

  test('notifies subscribers when the websocket opens and closes', async () => {
    FakeWebSocket.instances = []
    const client = new HttpClient({
      baseUrl: 'http://localhost:32123',
      token: 'token',
      webSocketImpl: FakeWebSocket,
    })
    const states: boolean[] = []
    const unsubscribe = client.onConnectionChange(connected => {
      states.push(connected)
    })

    const iterator = client.sendMessage('hello')
    const first = iterator.next()
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    ws.message(initEvent('session'))
    await waitTick()
    ws.message({
      type: 'result',
      subtype: 'success',
      result: 'ok',
      num_turns: 1,
      total_cost_usd: 0,
      duration_ms: 1,
      duration_api_ms: 0,
      is_error: false,
      session_id: 'session',
      uuid: 'result-1',
    })
    await first
    await iterator.next()

    ws.close()
    unsubscribe()

    expect(states).toEqual([true, false])
  })

  test('attachSession connects with the requested session id and waits for history', async () => {
    FakeWebSocket.instances = []
    const client = new HttpClient({
      baseUrl: 'http://localhost:32123',
      token: 'token',
      workspaceId: 'workspace-a',
      webSocketImpl: FakeWebSocket,
    })
    const sessionId = '11111111-1111-4111-8111-111111111111'

    let attached = false
    const attaching = client.attachSession(sessionId).then(() => {
      attached = true
    })
    const ws = FakeWebSocket.instances[0]!
    const url = new URL(ws.url)

    expect(url.pathname).toBe('/ws')
    expect(url.searchParams.get('workspace')).toBe('workspace-a')
    expect(url.searchParams.get('session_id')).toBe(sessionId)

    ws.open()
    await waitTick()
    expect(attached).toBe(false)

    ws.message(initEvent(sessionId))
    await waitTick()
    expect(attached).toBe(false)
    completeHistory(ws, sessionId)
    await attaching

    expect(client.getAttachedSessionId()).toBe(sessionId)
  })

  test('concurrent attachSession calls share the same connection attempt', async () => {
    FakeWebSocket.instances = []
    const client = new HttpClient({
      baseUrl: 'http://localhost:32123',
      token: 'token',
      webSocketImpl: FakeWebSocket,
    })
    const sessionId = '12121212-1212-4212-8212-121212121212'

    const first = client.attachSession(sessionId)
    const second = client.attachSession(sessionId)

    expect(FakeWebSocket.instances).toHaveLength(1)
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    ws.message(initEvent(sessionId))
    completeHistory(ws, sessionId)

    await Promise.all([first, second])
    expect(client.getAttachedSessionId()).toBe(sessionId)
  })

  test('attachSession rejects an unexpected init session id', async () => {
    FakeWebSocket.instances = []
    const client = new HttpClient({
      baseUrl: 'http://localhost:32123',
      token: 'token',
      webSocketImpl: FakeWebSocket,
    })
    const requested = '13131313-1313-4313-8313-131313131313'
    const unexpected = '14141414-1414-4414-8414-141414141414'

    const attaching = client.attachSession(requested)
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    ws.message(initEvent(unexpected))

    await expect(attaching).rejects.toThrow(
      `Server attached unexpected session (${unexpected}; expected ${requested})`,
    )
    expect(client.getAttachedSessionId()).toBeNull()
    expect(client.isConnected()).toBe(false)
  })

  test('startSession waits for init and returns the announced session id', async () => {
    FakeWebSocket.instances = []
    const client = new HttpClient({
      baseUrl: 'http://localhost:32123',
      token: 'token',
      webSocketImpl: FakeWebSocket,
    })
    const sessionId = '22222222-2222-4222-8222-222222222222'

    const starting = client.startSession()
    const ws = FakeWebSocket.instances[0]!
    expect(new URL(ws.url).searchParams.has('session_id')).toBe(false)

    ws.open()
    ws.message(initEvent(sessionId))

    expect(await starting).toBe(sessionId)
    expect(client.getAttachedSessionId()).toBe(sessionId)
  })

  test('registers message handling before open so an early init is retained', async () => {
    FakeWebSocket.instances = []
    const client = new HttpClient({
      baseUrl: 'http://localhost:32123',
      token: 'token',
      webSocketImpl: FakeWebSocket,
    })
    const sessionId = '33333333-3333-4333-8333-333333333333'

    const starting = client.startSession()
    const ws = FakeWebSocket.instances[0]!
    ws.message(initEvent(sessionId))
    ws.open()

    expect(await starting).toBe(sessionId)
  })

  test('persistent subscribers receive idle events outside sendMessage', async () => {
    FakeWebSocket.instances = []
    const client = new HttpClient({
      baseUrl: 'http://localhost:32123',
      token: 'token',
      webSocketImpl: FakeWebSocket,
    })
    const sessionId = '44444444-4444-4444-8444-444444444444'
    const seen: string[] = []
    const unsubscribe = client.subscribeEvents(event => {
      if (event.type === 'user') seen.push(String(event.message.content))
    })

    const starting = client.startSession()
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    ws.message(initEvent(sessionId))
    await starting

    ws.message(userEvent(sessionId, 'from another client', 'user-remote'))
    unsubscribe()

    expect(seen).toEqual(['from another client'])
  })

  test('switching sessions preserves persistent event subscribers', async () => {
    FakeWebSocket.instances = []
    const client = new HttpClient({
      baseUrl: 'http://localhost:32123',
      token: 'token',
      webSocketImpl: FakeWebSocket,
    })
    const firstId = '55555555-5555-4555-8555-555555555555'
    const secondId = '66666666-6666-4666-8666-666666666666'
    const seen: string[] = []
    client.subscribeEvents(event => {
      if (event.type === 'user') seen.push(String(event.message.content))
    })

    const starting = client.startSession()
    const firstSocket = FakeWebSocket.instances[0]!
    firstSocket.open()
    firstSocket.message(initEvent(firstId))
    await starting
    firstSocket.message(userEvent(firstId, 'first', 'user-first'))

    const attaching = client.attachSession(secondId)
    const secondSocket = FakeWebSocket.instances[1]!
    expect(firstSocket.readyState).toBe(3)
    secondSocket.open()
    secondSocket.message(initEvent(secondId))
    completeHistory(secondSocket, secondId)
    await attaching
    secondSocket.message(userEvent(secondId, 'second', 'user-second'))

    expect(seen).toEqual(['first', 'second'])
    expect(client.getAttachedSessionId()).toBe(secondId)
  })

  test('attachSession rejects websocket errors while connecting', async () => {
    FakeWebSocket.instances = []
    const client = new HttpClient({
      baseUrl: 'http://localhost:32123',
      token: 'token',
      webSocketImpl: FakeWebSocket,
    })

    const attaching = client.attachSession(
      '77777777-7777-4777-8777-777777777777',
    )
    FakeWebSocket.instances[0]!.error()

    await expect(attaching).rejects.toThrow('WebSocket connection error')
    expect(client.isConnected()).toBe(false)
  })

  test('attachSession rejects closes before initialization', async () => {
    FakeWebSocket.instances = []
    const client = new HttpClient({
      baseUrl: 'http://localhost:32123',
      token: 'token',
      webSocketImpl: FakeWebSocket,
    })

    const attaching = client.attachSession(
      '88888888-8888-4888-8888-888888888888',
    )
    FakeWebSocket.instances[0]!.close()

    await expect(attaching).rejects.toThrow(
      'WebSocket connection closed before session synchronization completed',
    )
    expect(client.isConnected()).toBe(false)
  })

  test('attachSession rejects disconnects before history replay completes', async () => {
    FakeWebSocket.instances = []
    const client = new HttpClient({
      baseUrl: 'http://localhost:32123',
      token: 'token',
      webSocketImpl: FakeWebSocket,
    })
    const sessionId = '89898989-8989-4989-8989-898989898989'

    const attaching = client.attachSession(sessionId)
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    ws.message(initEvent(sessionId))
    ws.message({ type: 'history_begin', sessionId })
    ws.close()

    await expect(attaching).rejects.toThrow(
      'WebSocket connection closed before session synchronization completed',
    )
    expect(client.isConnected()).toBe(false)
  })

  test('uses a separate timeout for history synchronization', async () => {
    FakeWebSocket.instances = []
    const client = new HttpClient({
      baseUrl: 'http://localhost:32123',
      token: 'token',
      webSocketImpl: FakeWebSocket,
      connectTimeoutMs: 5,
      historySyncTimeoutMs: 100,
    })
    const sessionId = '90909090-9090-4090-8090-909090909090'

    const attaching = client.attachSession(sessionId)
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    ws.message(initEvent(sessionId))

    await waitMs(15)
    completeHistory(ws, sessionId)

    await attaching
    expect(client.getAttachedSessionId()).toBe(sessionId)
  })

  test('rejects when history synchronization exceeds its own timeout', async () => {
    FakeWebSocket.instances = []
    const client = new HttpClient({
      baseUrl: 'http://localhost:32123',
      token: 'token',
      webSocketImpl: FakeWebSocket,
      connectTimeoutMs: 100,
      historySyncTimeoutMs: 5,
    })
    const sessionId = '91919191-9191-4191-8191-919191919191'

    const attaching = client.attachSession(sessionId)
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    ws.message(initEvent(sessionId))

    await expect(attaching).rejects.toThrow(
      'WebSocket history synchronization timeout',
    )
  })

  test('concurrent session startup and send share one connection attempt', async () => {
    FakeWebSocket.instances = []
    const client = new HttpClient({
      baseUrl: 'http://localhost:32123',
      token: 'token',
      webSocketImpl: FakeWebSocket,
    })
    const sessionId = '99999999-9999-4999-8999-999999999999'

    const starting = client.startSession()
    const iterator = client.sendMessage('hello')
    const first = iterator.next()

    expect(FakeWebSocket.instances).toHaveLength(1)
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    ws.message(initEvent(sessionId))

    expect(await starting).toBe(sessionId)
    await waitTick()
    expect(JSON.parse(ws.sent[0] ?? '{}')).toMatchObject({
      type: 'prompt',
      prompt: 'hello',
    })

    ws.message({
      type: 'result',
      subtype: 'success',
      result: 'ok',
      num_turns: 1,
      total_cost_usd: 0,
      duration_ms: 1,
      duration_api_ms: 0,
      is_error: false,
      session_id: sessionId,
      uuid: 'result-concurrent',
    })

    expect(await first).toMatchObject({
      done: false,
      value: { type: 'result', result: 'ok' },
    })
    expect(await iterator.next()).toMatchObject({ done: true })
  })

  test('rejects a second concurrent send without consuming the first result', async () => {
    FakeWebSocket.instances = []
    const client = new HttpClient({
      baseUrl: 'http://localhost:32123',
      token: 'token',
      webSocketImpl: FakeWebSocket,
    })

    const firstIterator = client.sendMessage('first')
    const first = firstIterator.next()
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    ws.message(initEvent('session'))
    await waitTick()

    const secondIterator = client.sendMessage('second')
    await expect(secondIterator.next()).rejects.toThrow(
      'Another message is already in flight for this client',
    )

    ws.message({
      type: 'result',
      subtype: 'success',
      result: 'first result',
      num_turns: 1,
      total_cost_usd: 0,
      duration_ms: 1,
      duration_api_ms: 0,
      is_error: false,
      session_id: 'session',
      uuid: 'result-first',
    })

    expect(await first).toMatchObject({
      done: false,
      value: { type: 'result', result: 'first result' },
    })
    expect(await firstIterator.next()).toMatchObject({ done: true })
  })

  test('cancelRequest during connection prevents the prompt from being sent', async () => {
    FakeWebSocket.instances = []
    const client = new HttpClient({
      baseUrl: 'http://localhost:32123',
      token: 'token',
      webSocketImpl: FakeWebSocket,
    })

    const iterator = client.sendMessage('should not send')
    const first = iterator.next()
    const ws = FakeWebSocket.instances[0]!

    client.cancelRequest()

    expect(await first).toMatchObject({ done: true })
    expect(ws.sent).toEqual([])

    // The shared socket may still finish connecting for a later request, but
    // the cancelled send must remain completed and must not emit a prompt.
    ws.open()
    ws.message(initEvent('session'))
    await waitTick()

    expect(ws.sent).toEqual([])
  })

  test('cancelRequest during history sync stays local and completes promptly', async () => {
    FakeWebSocket.instances = []
    const client = new HttpClient({
      baseUrl: 'http://localhost:32123',
      token: 'token',
      webSocketImpl: FakeWebSocket,
    })
    const sessionId = '92929292-9292-4292-8292-929292929292'

    const attaching = client.attachSession(sessionId)
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    ws.message(initEvent(sessionId))
    ws.message({ type: 'history_begin', sessionId })

    const iterator = client.sendMessage('should remain local')
    const first = iterator.next()
    client.cancelRequest()

    expect(await first).toMatchObject({ done: true })
    expect(ws.sent).toEqual([])

    ws.message({ type: 'history_end', sessionId })
    await attaching
    expect(ws.sent).toEqual([])
  })

  test('cancelRequest sends cancel after the prompt is in flight', async () => {
    FakeWebSocket.instances = []
    const client = new HttpClient({
      baseUrl: 'http://localhost:32123',
      token: 'token',
      webSocketImpl: FakeWebSocket,
    })

    const iterator = client.sendMessage('stop me')
    const first = iterator.next()
    const ws = FakeWebSocket.instances[0]!
    ws.open()
    ws.message(initEvent('session'))
    await waitTick()

    client.cancelRequest()
    const sent = ws.sent.map(message => JSON.parse(message))
    expect(sent).toHaveLength(2)
    expect(sent[0]).toMatchObject({ type: 'prompt', prompt: 'stop me' })
    expect(sent[1]).toMatchObject({
      type: 'cancel',
      clientMessageUuid: sent[0]?.clientMessageUuid,
    })

    ws.message({
      type: 'result',
      subtype: 'error_during_execution',
      result: '',
      num_turns: 1,
      total_cost_usd: 0,
      duration_ms: 1,
      duration_api_ms: 0,
      is_error: true,
      session_id: 'session',
      uuid: 'result-cancelled',
    })

    expect(await first).toMatchObject({
      done: false,
      value: { type: 'result', is_error: true },
    })
    expect(await iterator.next()).toMatchObject({ done: true })
  })

  test('listSessions reads sessions over HTTP without opening a websocket', async () => {
    FakeWebSocket.instances = []
    const fetchCalls: Array<{ url: string; headers: Record<string, string> }> =
      []
    const client = new HttpClient({
      baseUrl: 'http://localhost:32123',
      token: 'token',
      workspaceId: 'workspace-a',
      webSocketImpl: FakeWebSocket,
      fetchImpl: async (input, init) => {
        fetchCalls.push({
          url: String(input),
          headers: init?.headers ?? {},
        })
        return Response.json({
          sessions: [
            {
              sessionId: '11111111-1111-4111-8111-111111111111',
              slug: 'saved-session',
              customTitle: null,
              tag: null,
              summary: null,
              cwd: '/repo',
              createdAt: null,
              modifiedAt: null,
            },
          ],
        })
      },
    })

    const sessions = await client.listSessions()

    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(fetchCalls).toEqual([
      {
        url: 'http://localhost:32123/api/sessions?workspace=workspace-a',
        headers: { authorization: 'Bearer token' },
      },
    ])
    expect(sessions).toHaveLength(1)
    expect(sessions[0]?.slug).toBe('saved-session')
  })

  test('listSessions rejects failed HTTP session list responses', async () => {
    const client = new HttpClient({
      baseUrl: 'http://localhost:32123',
      token: 'token',
      webSocketImpl: FakeWebSocket,
      fetchImpl: async () =>
        Response.json({ ok: false, error: 'missing' }, { status: 503 }),
    })

    await expect(client.listSessions()).rejects.toThrow(
      'Failed to list sessions (503)',
    )
  })

  test('listSessions rejects malformed HTTP session list responses', async () => {
    const client = new HttpClient({
      baseUrl: 'http://localhost:32123',
      token: 'token',
      webSocketImpl: FakeWebSocket,
      fetchImpl: async () => Response.json({ sessions: [{ slug: 'missing' }] }),
    })

    await expect(client.listSessions()).rejects.toThrow(
      'Invalid sessions response',
    )
  })

  test('getRuntimeStatus reads daemon status over HTTP', async () => {
    FakeWebSocket.instances = []
    const fetchCalls: Array<{ url: string; headers: Record<string, string> }> =
      []
    const client = new HttpClient({
      baseUrl: 'http://localhost:32123',
      token: 'token',
      workspaceId: 'workspace-a',
      webSocketImpl: FakeWebSocket,
      fetchImpl: async (input, init) => {
        fetchCalls.push({
          url: String(input),
          headers: init?.headers ?? {},
        })
        return Response.json({
          ok: true,
          transport: 'daemon',
          pid: 123,
          version: '2.2.1',
          activeSessions: 2,
        })
      },
    })

    const status = await client.getRuntimeStatus()

    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(fetchCalls).toEqual([
      {
        url: 'http://localhost:32123/api/health?workspace=workspace-a',
        headers: { authorization: 'Bearer token' },
      },
    ])
    expect(status).toEqual({
      ok: true,
      transport: 'daemon',
      pid: 123,
      version: '2.2.1',
      activeSessions: 2,
    })
  })

  test('getRuntimeStatus rejects failed HTTP status responses', async () => {
    const client = new HttpClient({
      baseUrl: 'http://localhost:32123',
      token: 'token',
      webSocketImpl: FakeWebSocket,
      fetchImpl: async () =>
        Response.json({ ok: false, error: 'missing' }, { status: 503 }),
    })

    await expect(client.getRuntimeStatus()).rejects.toThrow(
      'Failed to read runtime status (503)',
    )
  })

  test('getRuntimeStatus rejects malformed HTTP status responses', async () => {
    const client = new HttpClient({
      baseUrl: 'http://localhost:32123',
      token: 'token',
      webSocketImpl: FakeWebSocket,
      fetchImpl: async () => Response.json({ ok: true }),
    })

    await expect(client.getRuntimeStatus()).rejects.toThrow(
      'Invalid runtime status response',
    )
  })

  test('loadSession reads history over HTTP without resuming websocket session', async () => {
    FakeWebSocket.instances = []
    const fetchCalls: Array<{ url: string; headers: Record<string, string> }> =
      []
    const client = new HttpClient({
      baseUrl: 'http://localhost:32123',
      token: 'token',
      workspaceId: 'workspace-a',
      webSocketImpl: FakeWebSocket,
      fetchImpl: async (input, init) => {
        fetchCalls.push({
          url: String(input),
          headers: init?.headers ?? {},
        })
        return Response.json({
          sessionId: '11111111-1111-4111-8111-111111111111',
          slug: 'saved-session',
          customTitle: null,
          tag: null,
          summary: null,
          cwd: '/repo',
          createdAt: null,
          modifiedAt: null,
          events: [
            {
              type: 'user',
              uuid: 'user-1',
              message: { role: 'user', content: 'hello' },
            },
          ],
        })
      },
    })

    const session = await client.loadSession(
      '11111111-1111-4111-8111-111111111111',
    )

    expect(FakeWebSocket.instances).toHaveLength(0)
    expect(fetchCalls).toEqual([
      {
        url: 'http://localhost:32123/api/sessions/11111111-1111-4111-8111-111111111111?workspace=workspace-a',
        headers: { authorization: 'Bearer token' },
      },
    ])
    expect(session.slug).toBe('saved-session')
    expect(session.events).toHaveLength(1)
    expect(session.events?.[0]?.type).toBe('user')
  })

  test('loadSession rejects failed HTTP history responses', async () => {
    const client = new HttpClient({
      baseUrl: 'http://localhost:32123',
      token: 'token',
      webSocketImpl: FakeWebSocket,
      fetchImpl: async () =>
        Response.json({ ok: false, error: 'missing' }, { status: 404 }),
    })

    await expect(
      client.loadSession('11111111-1111-4111-8111-111111111111'),
    ).rejects.toThrow('Failed to load session (404)')
  })

  test('loadSession rejects malformed HTTP history responses', async () => {
    const client = new HttpClient({
      baseUrl: 'http://localhost:32123',
      token: 'token',
      webSocketImpl: FakeWebSocket,
      fetchImpl: async () => Response.json({ ok: true }),
    })

    await expect(
      client.loadSession('11111111-1111-4111-8111-111111111111'),
    ).rejects.toThrow('Invalid session response')
  })

  test('deleteSession archives a daemon session over authenticated HTTP', async () => {
    const fetchCalls: Array<{
      url: string
      method: string | undefined
      headers: Record<string, string>
    }> = []
    const client = new HttpClient({
      baseUrl: 'http://localhost:32123',
      token: 'token',
      workspaceId: 'workspace-a',
      webSocketImpl: FakeWebSocket,
      fetchImpl: async (input, init) => {
        fetchCalls.push({
          url: String(input),
          method: init?.method,
          headers: init?.headers ?? {},
        })
        return Response.json({ ok: true, archived: true })
      },
    })

    await client.deleteSession('11111111-1111-4111-8111-111111111111')

    expect(fetchCalls).toEqual([
      {
        url: 'http://localhost:32123/api/sessions/11111111-1111-4111-8111-111111111111?workspace=workspace-a',
        method: 'DELETE',
        headers: { authorization: 'Bearer token' },
      },
    ])
  })

  test('deleteSession rejects invalid ids before issuing a request', async () => {
    let calls = 0
    const client = new HttpClient({
      baseUrl: 'http://localhost:32123',
      token: 'token',
      webSocketImpl: FakeWebSocket,
      fetchImpl: async () => {
        calls += 1
        return Response.json({ ok: true })
      },
    })

    await expect(client.deleteSession('not-a-uuid')).rejects.toThrow(
      'Invalid session id',
    )
    expect(calls).toBe(0)
  })

  test('updates metadata and forks sessions through the experimental control API', async () => {
    const calls: Array<{
      url: string
      method: string | undefined
      body: string | undefined
    }> = []
    const session = {
      sessionId: '11111111-1111-4111-8111-111111111111',
      slug: 'forked-session',
      customTitle: 'Forked',
      tag: 'work',
      summary: 'summary',
      cwd: '/repo',
      createdAt: null,
      modifiedAt: null,
    }
    const client = new HttpClient({
      baseUrl: 'http://localhost:32123',
      token: 'token',
      webSocketImpl: FakeWebSocket,
      fetchImpl: async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method,
          body: init?.body,
        })
        return Response.json({ ok: true, session })
      },
    })

    await expect(
      client.updateSessionMetadata(session.sessionId, {
        customTitle: null,
        summary: 'new summary',
      }),
    ).resolves.toMatchObject({ customTitle: 'Forked' })
    await expect(
      client.forkSession(session.sessionId, {
        newSessionId: '22222222-2222-4222-8222-222222222222',
        beforeUuid: '33333333-3333-4333-8333-333333333333',
      }),
    ).resolves.toMatchObject({ sessionId: session.sessionId })

    expect(calls).toEqual([
      {
        url: `http://localhost:32123/api/sessions/${session.sessionId}`,
        method: 'PATCH',
        body: JSON.stringify({ customTitle: null, summary: 'new summary' }),
      },
      {
        url: `http://localhost:32123/api/sessions/${session.sessionId}/fork`,
        method: 'POST',
        body: JSON.stringify({
          newSessionId: '22222222-2222-4222-8222-222222222222',
          beforeUuid: '33333333-3333-4333-8333-333333333333',
        }),
      },
    ])
  })

  test('lists, creates, and transitions goal schedules over authenticated HTTP', async () => {
    const schedule = {
      id: 'schedule-local-loop',
      goalId: 'local-loop',
      kind: 'interval' as const,
      status: 'scheduled',
      revision: 1,
      nextRunAt: 100,
      createdAt: 1,
      updatedAt: 2,
      objective: 'Watch CI',
      everyMs: 60_000,
      anchorAt: 100,
    }
    const paused = { ...schedule, status: 'paused', revision: 2 }
    const calls: Array<{ url: string; method?: string; body?: string }> = []
    const client = new HttpClient({
      baseUrl: 'http://localhost:32123',
      token: 'token',
      workspaceId: 'workspace-a',
      webSocketImpl: FakeWebSocket,
      fetchImpl: async (input, init) => {
        const url = new URL(String(input))
        calls.push({
          url: url.toString(),
          method: init?.method,
          body: init?.body,
        })
        if (url.pathname === '/api/goal-schedules' && !init?.method) {
          return Response.json({ schedules: [schedule] })
        }
        if (url.pathname === '/api/goal-schedules' && init?.method === 'POST') {
          return Response.json({ ok: true, schedule }, { status: 201 })
        }
        if (url.pathname.endsWith('/actions') && init?.method === 'POST') {
          return Response.json({ ok: true, schedule: paused })
        }
        return new Response('not found', { status: 404 })
      },
    })

    await expect(
      client.listGoalSchedules({
        sessionId: '11111111-1111-4111-8111-111111111111',
      }),
    ).resolves.toEqual([schedule])
    await expect(
      client.createGoalSchedule({
        sessionId: '11111111-1111-4111-8111-111111111111',
        objective: 'Watch CI',
        schedule: { kind: 'interval', everyMs: 60_000 },
      }),
    ).resolves.toEqual(schedule)
    await expect(
      client.transitionGoalSchedule(schedule.id, {
        sessionId: '11111111-1111-4111-8111-111111111111',
        expectedRevision: 1,
        action: 'pause',
        reason: 'hold',
      }),
    ).resolves.toEqual(paused)
    expect(calls.some(call => call.url.includes('/api/goal-schedules'))).toBe(
      true,
    )
  })

  test('surfaces daemon JSON errors for goal schedule mutations', async () => {
    const client = new HttpClient({
      baseUrl: 'http://localhost:32123',
      token: 'token',
      workspaceId: 'workspace-a',
      webSocketImpl: FakeWebSocket,
      fetchImpl: async () =>
        Response.json(
          { ok: false, error: 'Revision conflict' },
          { status: 409 },
        ),
    })

    await expect(
      client.transitionGoalSchedule('schedule-1', {
        sessionId: '11111111-1111-4111-8111-111111111111',
        expectedRevision: 2,
        action: 'pause',
      }),
    ).rejects.toThrow(/Revision conflict/)
  })

  test('uses the daemon task and permission control contracts over authenticated HTTP', async () => {
    const task: DaemonTask = {
      id: 'shell-1',
      kind: 'shell',
      status: 'running',
      source: 'runtime_and_durable',
      description: 'run checks',
      command: 'bun test',
      sessionId: '11111111-1111-4111-8111-111111111111',
      startedAt: 1,
      updatedAt: 2,
      completedAt: null,
      outputAvailable: true,
      error: null,
    }
    const permission: DaemonPermissionSnapshot = {
      source: 'runtime',
      sessionId: task.sessionId,
      mode: 'yolo',
      isBypassPermissionsModeAvailable: true,
      additionalWorkingDirectories: [],
      rules: { allow: {}, deny: {}, ask: {} },
    }
    const calls: Array<{
      url: string
      method: string | undefined
      body: string | undefined
    }> = []
    const client = new HttpClient({
      baseUrl: 'http://localhost:32123',
      token: 'token',
      workspaceId: 'workspace-a',
      webSocketImpl: FakeWebSocket,
      fetchImpl: async (input, init) => {
        const url = new URL(String(input))
        calls.push({
          url: url.toString(),
          method: init?.method,
          body: init?.body,
        })
        if (url.pathname === '/api/tasks')
          return Response.json({ tasks: [task] })
        if (url.pathname.endsWith('/output')) {
          return Response.json({ task, content: 'tail', tailLines: 25 })
        }
        if (url.pathname.endsWith('/cancel')) {
          return Response.json({
            task,
            cancelled: true,
            alreadyTerminal: false,
          })
        }
        if (url.pathname.startsWith('/api/tasks/'))
          return Response.json({ task })
        if (init?.method === 'PATCH') {
          return Response.json({
            permission,
            persisted: false,
            refreshedSessionIds: [task.sessionId],
            inflightApprovalCount: 0,
          })
        }
        return Response.json({ permission })
      },
    })

    await expect(
      client.listTasks({ sessionId: task.sessionId }),
    ).resolves.toEqual([task])
    await expect(client.getTask(task.id)).resolves.toEqual(task)
    await expect(
      client.getTaskOutput(task.id, {
        sessionId: task.sessionId,
        tailLines: 25,
      }),
    ).resolves.toMatchObject({ content: 'tail', tailLines: 25 })
    await expect(client.cancelTask(task.id)).resolves.toMatchObject({
      cancelled: true,
    })
    await expect(
      client.getPermissions({ sessionId: task.sessionId }),
    ).resolves.toEqual(permission)
    await expect(
      client.updatePermissions({
        sessionId: task.sessionId,
        update: {
          type: 'addRules',
          destination: 'session',
          behavior: 'allow',
          rules: ['Bash(git status)'],
        },
      }),
    ).resolves.toMatchObject({ persisted: false })

    expect(calls).toEqual([
      {
        url: `http://localhost:32123/api/tasks?workspace=workspace-a&sessionId=${task.sessionId}`,
        method: undefined,
        body: undefined,
      },
      {
        url: 'http://localhost:32123/api/tasks/shell-1?workspace=workspace-a',
        method: undefined,
        body: undefined,
      },
      {
        url: `http://localhost:32123/api/tasks/shell-1/output?workspace=workspace-a&sessionId=${task.sessionId}&tail=25`,
        method: undefined,
        body: undefined,
      },
      {
        url: 'http://localhost:32123/api/tasks/shell-1/cancel?workspace=workspace-a',
        method: 'POST',
        body: undefined,
      },
      {
        url: `http://localhost:32123/api/permissions?workspace=workspace-a&sessionId=${task.sessionId}`,
        method: undefined,
        body: undefined,
      },
      {
        url: 'http://localhost:32123/api/permissions?workspace=workspace-a',
        method: 'PATCH',
        body: JSON.stringify({
          sessionId: task.sessionId,
          update: {
            type: 'addRules',
            destination: 'session',
            behavior: 'allow',
            rules: ['Bash(git status)'],
          },
        }),
      },
    ])
  })

  test('uses Agent controls with workspace scope, revision bodies, and strict responses', async () => {
    const revision = 'a'.repeat(64)
    const agent: DaemonManagedAgent = {
      source: 'projectSettings',
      agentType: 'review-agent',
      whenToUse: 'Review changes for correctness and regressions.',
      systemPrompt: 'Review the requested change and report findings.',
      tools: ['Read', 'Grep'],
      revision,
    }
    const calls: Array<{
      url: string
      method: string | undefined
      body: string | undefined
    }> = []
    const client = new HttpClient({
      baseUrl: 'http://localhost:32123',
      token: 'token',
      workspaceId: 'workspace-a',
      webSocketImpl: FakeWebSocket,
      fetchImpl: async (input, init) => {
        const url = new URL(String(input))
        calls.push({
          url: url.toString(),
          method: init?.method,
          body: init?.body,
        })
        if (init?.method === 'POST' || init?.method === 'PATCH') {
          return Response.json({ agent, appliesTo: 'new_subagents' })
        }
        if (init?.method === 'DELETE') return Response.json({ deleted: true })
        if (url.pathname === '/api/agents')
          return Response.json({ agents: [agent] })
        return Response.json({ agent })
      },
    })

    await expect(client.listAgents()).resolves.toEqual([agent])
    await expect(
      client.getAgent('review-agent', 'projectSettings'),
    ).resolves.toEqual(agent)
    await expect(
      client.createAgent({
        source: 'projectSettings',
        agent: {
          agentType: 'review-agent',
          whenToUse: agent.whenToUse,
          systemPrompt: agent.systemPrompt,
          tools: agent.tools,
        },
      }),
    ).resolves.toMatchObject({ appliesTo: 'new_subagents' })
    await expect(
      client.updateAgent('review-agent', {
        source: 'projectSettings',
        expectedRevision: revision,
        agent: {
          agentType: 'review-agent',
          whenToUse: agent.whenToUse,
          systemPrompt: agent.systemPrompt,
          tools: agent.tools,
          color: 'blue',
        },
      }),
    ).resolves.toMatchObject({ agent: { revision } })
    await expect(
      client.deleteAgent('review-agent', {
        source: 'projectSettings',
        expectedRevision: revision,
      }),
    ).resolves.toEqual({ deleted: true })

    expect(calls).toEqual([
      {
        url: 'http://localhost:32123/api/agents?workspace=workspace-a',
        method: undefined,
        body: undefined,
      },
      {
        url: 'http://localhost:32123/api/agents/review-agent?workspace=workspace-a&source=projectSettings',
        method: undefined,
        body: undefined,
      },
      {
        url: 'http://localhost:32123/api/agents?workspace=workspace-a',
        method: 'POST',
        body: JSON.stringify({
          source: 'projectSettings',
          agent: {
            agentType: 'review-agent',
            whenToUse: agent.whenToUse,
            systemPrompt: agent.systemPrompt,
            tools: agent.tools,
          },
        }),
      },
      {
        url: 'http://localhost:32123/api/agents/review-agent?workspace=workspace-a',
        method: 'PATCH',
        body: JSON.stringify({
          source: 'projectSettings',
          expectedRevision: revision,
          agent: {
            agentType: 'review-agent',
            whenToUse: agent.whenToUse,
            systemPrompt: agent.systemPrompt,
            tools: agent.tools,
            color: 'blue',
          },
        }),
      },
      {
        url: 'http://localhost:32123/api/agents/review-agent?workspace=workspace-a',
        method: 'DELETE',
        body: JSON.stringify({
          source: 'projectSettings',
          expectedRevision: revision,
        }),
      },
    ])
  })

  test('rejects invalid Agent ids locally and malformed delete responses strictly', async () => {
    const request = {
      source: 'projectSettings' as const,
      expectedRevision: 'a'.repeat(64),
    }
    let calls = 0
    const client = new HttpClient({
      baseUrl: 'http://localhost:32123',
      token: 'token',
      fetchImpl: async () => {
        calls += 1
        return Response.json({ deleted: true, unexpected: 'field' })
      },
    })

    await expect(client.getAgent('ab', 'projectSettings')).rejects.toThrow(
      'Invalid agent type',
    )
    await expect(client.deleteAgent('x'.repeat(51), request)).rejects.toThrow(
      'Invalid agent type',
    )
    expect(calls).toBe(0)

    await expect(client.deleteAgent('review-agent', request)).rejects.toThrow(
      'Invalid agent delete response',
    )
    expect(calls).toBe(1)
  })
})
