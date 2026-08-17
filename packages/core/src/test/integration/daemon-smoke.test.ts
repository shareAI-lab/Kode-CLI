import { describe, expect, test } from 'bun:test'
import { WebSocket as WsClient } from 'ws'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { startKodeDaemon } from '#daemon/server'
import { getSessionLogFilePath } from '#protocol/utils/kodeAgentSessionLog'

type AnyEvent = any

function decodeWsMessageData(raw: unknown): string {
  if (typeof raw === 'string') return raw
  if (raw instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(raw))
  }
  if (ArrayBuffer.isView(raw)) {
    const view = raw as ArrayBufferView
    return new TextDecoder().decode(
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
    )
  }
  return String(raw ?? '')
}

function waitForEvent(
  label: string,
  events: AnyEvent[],
  predicate: (e: AnyEvent) => boolean,
  timeoutMs: number,
): Promise<AnyEvent> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tick = () => {
      const found = events.find(predicate)
      if (found) return resolve(found)
      if (Date.now() > deadline) {
        return reject(new Error(`timeout (${label}, events=${events.length})`))
      }
      setTimeout(tick, 10)
    }
    tick()
  })
}

function waitForEventSince(
  label: string,
  events: AnyEvent[],
  startIndex: number,
  predicate: (e: AnyEvent) => boolean,
  timeoutMs: number,
): Promise<AnyEvent> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tick = () => {
      const found = events.slice(startIndex).find(predicate)
      if (found) return resolve(found)
      if (Date.now() > deadline) {
        return reject(
          new Error(`timeout (${label}, events=${events.length - startIndex})`),
        )
      }
      setTimeout(tick, 10)
    }
    tick()
  })
}

async function closeWs(ws: WsClient): Promise<void> {
  await new Promise<void>(resolve => {
    const done = () => resolve()
    const timer = setTimeout(done, 250)
    try {
      ws.once('close', () => {
        clearTimeout(timer)
        done()
      })
      ws.close()
    } catch {
      clearTimeout(timer)
      done()
    }
  })
}

async function openDaemonWs(
  daemon: { host: string; port: number; token: string },
  sessionId?: string,
): Promise<{ ws: WsClient; events: AnyEvent[] }> {
  const sessionParam = sessionId
    ? `&session_id=${encodeURIComponent(sessionId)}`
    : ''
  const ws = new WsClient(
    `ws://${daemon.host}:${daemon.port}/ws?token=${encodeURIComponent(daemon.token)}${sessionParam}`,
  )
  const events: AnyEvent[] = []
  ws.on('message', data => {
    try {
      events.push(JSON.parse(decodeWsMessageData(data)))
    } catch {
      /* no-op */
    }
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', err =>
      reject(err instanceof Error ? err : new Error(String(err))),
    )
  })
  return { ws, events }
}

async function waitForInit(events: AnyEvent[]): Promise<AnyEvent> {
  return await waitForEvent(
    'init',
    events,
    event => event?.type === 'system' && event.subtype === 'init',
    5_000,
  )
}

describe('daemon (Bun HTTP+WS)', () => {
  test('health + token gate + ws prompt (echo)', async () => {
    const daemon = await startKodeDaemon({
      cwd: process.cwd(),
      port: 0,
      echo: true,
    })

    try {
      const health = await fetch(
        `http://${daemon.host}:${daemon.port}/health`,
      ).then(r => r.json())
      expect(health.ok).toBe(true)

      const unauthorized = await fetch(
        `http://${daemon.host}:${daemon.port}/api/health`,
      )
      expect(unauthorized.status).toBe(401)

      const authorized = await fetch(
        `http://${daemon.host}:${daemon.port}/api/health?token=${encodeURIComponent(
          daemon.token,
        )}`,
      ).then(r => r.json())
      expect(authorized.ok).toBe(true)

      const invalidChatSession = await fetch(
        `http://${daemon.host}:${daemon.port}/api/chat?token=${encodeURIComponent(daemon.token)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: '../invalid', prompt: 'hello' }),
        },
      )
      expect(invalidChatSession.status).toBe(400)

      const ws = new WsClient(
        `ws://${daemon.host}:${daemon.port}/ws?token=${encodeURIComponent(
          daemon.token,
        )}`,
      )

      const events: AnyEvent[] = []
      ws.on('message', data => {
        try {
          events.push(JSON.parse(decodeWsMessageData(data)))
        } catch {
          /* no-op */
        }
      })

      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve())
        ws.once('error', err =>
          reject(
            err instanceof Error
              ? err
              : new Error(err ? String(err) : 'ws error'),
          ),
        )
      })

      await waitForEvent(
        'init',
        events,
        e => e && e.type === 'system' && e.subtype === 'init',
        5_000,
      )

      ws.send(JSON.stringify({ type: 'prompt', prompt: 'hello' }))

      const result = await waitForEvent(
        'result',
        events,
        e => e && e.type === 'result',
        5_000,
      )
      expect(result.is_error).toBe(false)
      expect(result.result).toBe('hello')

      const assistant = await waitForEvent(
        'assistant',
        events,
        e => e && e.type === 'assistant',
        5_000,
      )
      const text = Array.isArray(assistant?.message?.content)
        ? assistant.message.content
            .filter((b: any) => b && b.type === 'text')
            .map((b: any) => String(b.text ?? ''))
            .join('')
        : ''
      expect(text).toContain('hello')

      await closeWs(ws)
    } finally {
      daemon.stop()
    }
  }, 20_000)

  test('reattaches to a daemon session after websocket disconnect', async () => {
    const daemon = await startKodeDaemon({
      cwd: process.cwd(),
      port: 0,
      echo: true,
    })

    try {
      const token = encodeURIComponent(daemon.token)
      const openWs = (sessionId?: string) => {
        const sessionParam = sessionId
          ? `&session_id=${encodeURIComponent(sessionId)}`
          : ''
        return new WsClient(
          `ws://${daemon.host}:${daemon.port}/ws?token=${token}${sessionParam}`,
        )
      }

      const first = openWs()
      const firstEvents: AnyEvent[] = []
      first.on('message', data => {
        try {
          firstEvents.push(JSON.parse(decodeWsMessageData(data)))
        } catch {
          /* no-op */
        }
      })

      await new Promise<void>((resolve, reject) => {
        first.once('open', () => resolve())
        first.once('error', err =>
          reject(
            err instanceof Error
              ? err
              : new Error(err ? String(err) : 'ws error'),
          ),
        )
      })

      const init = await waitForEvent(
        'init',
        firstEvents,
        e => e && e.type === 'system' && e.subtype === 'init',
        5_000,
      )
      const sessionId = String(init.session_id ?? '')
      expect(sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      )

      await closeWs(first)

      const chatResponse = await fetch(
        `http://${daemon.host}:${daemon.port}/api/chat?token=${token}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, prompt: 'background hello' }),
        },
      )
      expect(chatResponse.status).toBe(200)
      expect((await chatResponse.json()).ok).toBe(true)

      await new Promise(resolve => setTimeout(resolve, 100))

      const second = openWs(sessionId)
      const secondEvents: AnyEvent[] = []
      second.on('message', data => {
        try {
          secondEvents.push(JSON.parse(decodeWsMessageData(data)))
        } catch {
          /* no-op */
        }
      })

      await new Promise<void>((resolve, reject) => {
        second.once('open', () => resolve())
        second.once('error', err =>
          reject(
            err instanceof Error
              ? err
              : new Error(err ? String(err) : 'ws error'),
          ),
        )
      })

      const reattachedInit = await waitForEvent(
        'reattached init',
        secondEvents,
        e => e && e.type === 'system' && e.subtype === 'init',
        5_000,
      )
      expect(reattachedInit.session_id).toBe(sessionId)

      const replayedAssistant = await waitForEvent(
        'history replay',
        secondEvents,
        e =>
          e &&
          e.type === 'assistant' &&
          Array.isArray(e.message?.content) &&
          e.message.content.some(
            (block: any) =>
              block?.type === 'text' &&
              String(block.text ?? '').includes('background hello'),
          ),
        5_000,
      )
      expect(replayedAssistant.session_id).toBe(sessionId)

      await closeWs(second)
    } finally {
      daemon.stop()
    }
  }, 20_000)

  test('broadcasts one turn to two clients attached to the same session', async () => {
    const daemon = await startKodeDaemon({
      cwd: process.cwd(),
      port: 0,
      echo: true,
    })
    let first: Awaited<ReturnType<typeof openDaemonWs>> | null = null
    let second: Awaited<ReturnType<typeof openDaemonWs>> | null = null

    try {
      first = await openDaemonWs(daemon)
      const firstInit = await waitForInit(first.events)
      const sessionId = String(firstInit.session_id ?? '')

      second = await openDaemonWs(daemon, sessionId)
      await waitForEvent(
        'empty history begin',
        second.events,
        event =>
          event?.type === 'history_begin' && event.sessionId === sessionId,
        5_000,
      )
      await waitForEvent(
        'empty history end',
        second.events,
        event => event?.type === 'history_end' && event.sessionId === sessionId,
        5_000,
      )

      first.ws.send(JSON.stringify({ type: 'prompt', prompt: 'shared turn' }))

      const firstAssistant = await waitForEvent(
        'first assistant',
        first.events,
        event => event?.type === 'assistant',
        5_000,
      )
      const secondAssistant = await waitForEvent(
        'second assistant',
        second.events,
        event => event?.type === 'assistant',
        5_000,
      )
      await waitForEvent(
        'first result',
        first.events,
        event => event?.type === 'result' && event.result === 'shared turn',
        5_000,
      )
      await waitForEvent(
        'second result',
        second.events,
        event => event?.type === 'result' && event.result === 'shared turn',
        5_000,
      )

      expect(firstAssistant.uuid).toBe(secondAssistant.uuid)
      expect(firstAssistant.session_id).toBe(sessionId)
      expect(secondAssistant.session_id).toBe(sessionId)
    } finally {
      if (first) await closeWs(first.ws)
      if (second) await closeWs(second.ws)
      daemon.stop()
    }
  }, 20_000)

  test('new_session and resume move only the requesting websocket', async () => {
    const daemon = await startKodeDaemon({
      cwd: process.cwd(),
      port: 0,
      echo: true,
    })
    let first: Awaited<ReturnType<typeof openDaemonWs>> | null = null
    let companion: Awaited<ReturnType<typeof openDaemonWs>> | null = null

    try {
      first = await openDaemonWs(daemon)
      const originalSessionId = String(
        (await waitForInit(first.events)).session_id ?? '',
      )
      companion = await openDaemonWs(daemon, originalSessionId)
      await waitForEvent(
        'companion history end',
        companion.events,
        event =>
          event?.type === 'history_end' &&
          event.sessionId === originalSessionId,
        5_000,
      )

      const firstSwitchIndex = first.events.length
      first.ws.send(JSON.stringify({ type: 'new_session' }))
      const switchedInit = await waitForEventSince(
        'new session init',
        first.events,
        firstSwitchIndex,
        event =>
          event?.type === 'system' &&
          event.subtype === 'init' &&
          event.session_id !== originalSessionId,
        5_000,
      )
      const newSessionId = String(switchedInit.session_id ?? '')
      await waitForEventSince(
        'new session empty history',
        first.events,
        firstSwitchIndex,
        event =>
          event?.type === 'history_end' && event.sessionId === newSessionId,
        5_000,
      )
      expect(
        companion.events.some(
          event =>
            event?.type === 'system' && event.session_id === newSessionId,
        ),
      ).toBe(false)

      const firstAfterSwitch = first.events.length
      companion.ws.send(
        JSON.stringify({ type: 'prompt', prompt: 'old room turn' }),
      )
      await waitForEvent(
        'old room result',
        companion.events,
        event => event?.type === 'result' && event.result === 'old room turn',
        5_000,
      )
      expect(
        first.events
          .slice(firstAfterSwitch)
          .some(
            event =>
              event?.type === 'result' && event.result === 'old room turn',
          ),
      ).toBe(false)

      const companionBeforeNewTurn = companion.events.length
      first.ws.send(JSON.stringify({ type: 'prompt', prompt: 'new room turn' }))
      await waitForEventSince(
        'new room result',
        first.events,
        firstAfterSwitch,
        event => event?.type === 'result' && event.result === 'new room turn',
        5_000,
      )
      expect(
        companion.events
          .slice(companionBeforeNewTurn)
          .some(
            event =>
              event?.type === 'result' && event.result === 'new room turn',
          ),
      ).toBe(false)

      const companionInitCount = companion.events.filter(
        event => event?.type === 'system' && event.subtype === 'init',
      ).length
      const resumeIndex = first.events.length
      first.ws.send(
        JSON.stringify({ type: 'resume', session_id: originalSessionId }),
      )
      await waitForEventSince(
        'resume original room',
        first.events,
        resumeIndex,
        event =>
          event?.type === 'system' &&
          event.subtype === 'init' &&
          event.session_id === originalSessionId,
        5_000,
      )
      expect(
        companion.events.filter(
          event => event?.type === 'system' && event.subtype === 'init',
        ),
      ).toHaveLength(companionInitCount)
    } finally {
      if (first) await closeWs(first.ws)
      if (companion) await closeWs(companion.ws)
      daemon.stop()
    }
  }, 20_000)

  test('restores a canonical session from disk after daemon restart', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'kode-daemon-restore-'))
    const projectDir = join(tempRoot, 'project')
    const configDir = join(tempRoot, 'config')
    mkdirSync(projectDir, { recursive: true })
    const previousConfigDir = process.env.KODE_CONFIG_DIR
    process.env.KODE_CONFIG_DIR = configDir

    const sessionId = randomUUID()
    const logPath = getSessionLogFilePath({ cwd: projectDir, sessionId })
    mkdirSync(dirname(logPath), { recursive: true })
    writeFileSync(
      logPath,
      [
        JSON.stringify({
          type: 'user',
          sessionId,
          uuid: randomUUID(),
          message: { role: 'user', content: 'persisted user' },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId,
          uuid: randomUUID(),
          message: {
            id: 'persisted-assistant',
            model: 'echo',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'persisted assistant' }],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    )

    let restarted: Awaited<ReturnType<typeof startKodeDaemon>> | null = null
    let attached: Awaited<ReturnType<typeof openDaemonWs>> | null = null
    try {
      const firstDaemon = await startKodeDaemon({
        cwd: projectDir,
        port: 0,
        echo: true,
      })
      firstDaemon.stop()

      restarted = await startKodeDaemon({
        cwd: projectDir,
        port: 0,
        echo: true,
      })

      const restoredChatResponse = await fetch(
        `http://${restarted.host}:${restarted.port}/api/chat?token=${encodeURIComponent(restarted.token)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            prompt: 'http restored turn',
          }),
        },
      )
      expect(restoredChatResponse.status).toBe(200)
      expect((await restoredChatResponse.json()).ok).toBe(true)
      await new Promise(resolve => setTimeout(resolve, 100))

      attached = await openDaemonWs(restarted, sessionId)

      expect((await waitForInit(attached.events)).session_id).toBe(sessionId)
      await waitForEvent(
        'restored assistant',
        attached.events,
        event =>
          event?.type === 'assistant' &&
          event.session_id === sessionId &&
          event.message?.content?.some?.(
            (block: AnyEvent) => block?.text === 'persisted assistant',
          ),
        5_000,
      )
      await waitForEvent(
        'restored history end',
        attached.events,
        event => event?.type === 'history_end' && event.sessionId === sessionId,
        5_000,
      )
      await waitForEvent(
        'HTTP-restored assistant',
        attached.events,
        event =>
          event?.type === 'assistant' &&
          event.session_id === sessionId &&
          event.message?.content?.some?.(
            (block: AnyEvent) => block?.text === 'http restored turn',
          ),
        5_000,
      )

      const unknownId = randomUUID()
      const rejected = await fetch(
        `http://${restarted.host}:${restarted.port}/ws?token=${encodeURIComponent(restarted.token)}&session_id=${unknownId}`,
      )
      expect(rejected.status).toBe(404)
      await expect(rejected.text()).resolves.toBe('Unknown session')
    } finally {
      if (attached) await closeWs(attached.ws)
      restarted?.stop()
      if (previousConfigDir === undefined) delete process.env.KODE_CONFIG_DIR
      else process.env.KODE_CONFIG_DIR = previousConfigDir
      rmSync(tempRoot, { recursive: true, force: true })
    }
  }, 20_000)

  test('persists fork metadata and archive state across daemon restart', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'kode-daemon-session-api-'))
    const projectDir = join(tempRoot, 'project')
    const configDir = join(tempRoot, 'config')
    mkdirSync(projectDir, { recursive: true })
    const previousConfigDir = process.env.KODE_CONFIG_DIR
    process.env.KODE_CONFIG_DIR = configDir

    let daemon: Awaited<ReturnType<typeof startKodeDaemon>> | null = null
    let source: Awaited<ReturnType<typeof openDaemonWs>> | null = null
    let observer: Awaited<ReturnType<typeof openDaemonWs>> | null = null
    const childSessionId = randomUUID()

    try {
      daemon = await startKodeDaemon({ cwd: projectDir, port: 0, echo: true })
      source = await openDaemonWs(daemon)
      const sourceSessionId = (await waitForInit(source.events)).session_id
      if (typeof sourceSessionId !== 'string' || !sourceSessionId) {
        throw new Error('daemon did not provide a session id')
      }

      source.ws.send(
        JSON.stringify({ type: 'prompt', prompt: 'fork source prompt' }),
      )
      await waitForEvent(
        'fork source result',
        source.events,
        event =>
          event?.type === 'result' && event.result === 'fork source prompt',
        5_000,
      )

      const base = `http://${daemon.host}:${daemon.port}`
      const forkResponse = await fetch(
        `${base}/api/sessions/${encodeURIComponent(sourceSessionId)}/fork?token=${encodeURIComponent(daemon.token)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            newSessionId: childSessionId,
            customTitle: 'Restartable fork',
            tag: 'integration',
            summary: 'Created from the live daemon session.',
          }),
        },
      )
      expect(forkResponse.status).toBe(200)
      await expect(forkResponse.json()).resolves.toMatchObject({
        ok: true,
        sessionId: childSessionId,
      })

      const patchResponse = await fetch(
        `${base}/api/sessions/${encodeURIComponent(childSessionId)}?token=${encodeURIComponent(daemon.token)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ summary: 'Updated before restart.' }),
        },
      )
      expect(patchResponse.status).toBe(200)

      await closeWs(source.ws)
      source = null
      daemon.stop()
      daemon = await startKodeDaemon({ cwd: projectDir, port: 0, echo: true })

      const restartedBase = `http://${daemon.host}:${daemon.port}`
      const detailResponse = await fetch(
        `${restartedBase}/api/sessions/${encodeURIComponent(childSessionId)}?token=${encodeURIComponent(daemon.token)}`,
      )
      expect(detailResponse.status).toBe(200)
      await expect(detailResponse.json()).resolves.toMatchObject({
        sessionId: childSessionId,
        customTitle: 'Restartable fork',
        tag: 'integration',
        summary: 'Updated before restart.',
        forkedFromSessionId: sourceSessionId,
        forkRootSessionId: sourceSessionId,
        events: [{ type: 'user' }, { type: 'assistant' }],
      })

      const deleteResponse = await fetch(
        `${restartedBase}/api/sessions/${encodeURIComponent(childSessionId)}?token=${encodeURIComponent(daemon.token)}`,
        { method: 'DELETE' },
      )
      expect(deleteResponse.status).toBe(200)
      const repeatedDelete = await fetch(
        `${restartedBase}/api/sessions/${encodeURIComponent(childSessionId)}?token=${encodeURIComponent(daemon.token)}`,
        { method: 'DELETE' },
      )
      expect(repeatedDelete.status).toBe(200)
      const archivedDetail = await fetch(
        `${restartedBase}/api/sessions/${encodeURIComponent(childSessionId)}?token=${encodeURIComponent(daemon.token)}`,
      )
      expect(archivedDetail.status).toBe(410)

      observer = await openDaemonWs(daemon)
      const observerSessionList = await waitForEvent(
        'metadata-aware session list',
        observer.events,
        event => event?.type === 'session_list',
        5_000,
      )
      expect(
        observerSessionList.sessions?.map(
          (session: { sessionId?: string }) => session.sessionId,
        ),
      ).not.toContain(childSessionId)
    } finally {
      if (source) await closeWs(source.ws)
      if (observer) await closeWs(observer.ws)
      daemon?.stop()
      if (previousConfigDir === undefined) delete process.env.KODE_CONFIG_DIR
      else process.env.KODE_CONFIG_DIR = previousConfigDir
      rmSync(tempRoot, { recursive: true, force: true })
    }
  }, 30_000)

  test('rejects concurrent daemon turns over HTTP and websocket', async () => {
    const daemon = await startKodeDaemon({
      cwd: process.cwd(),
      port: 0,
      echo: true,
      echoDelayMs: 250,
    })
    let first: Awaited<ReturnType<typeof openDaemonWs>> | null = null
    let second: Awaited<ReturnType<typeof openDaemonWs>> | null = null

    try {
      first = await openDaemonWs(daemon)
      second = await openDaemonWs(daemon)
      const firstSessionId = String(
        (await waitForInit(first.events)).session_id ?? '',
      )
      const secondSessionId = String(
        (await waitForInit(second.events)).session_id ?? '',
      )

      first.ws.send(JSON.stringify({ type: 'prompt', prompt: 'held turn' }))
      await waitForEvent(
        'held turn accepted',
        first.events,
        event => event?.type === 'user' && event.session_id === firstSessionId,
        5_000,
      )

      const controlIndex = first.events.length
      first.ws.send(
        JSON.stringify({ type: 'resume', session_id: secondSessionId }),
      )
      await waitForEventSince(
        'active turn session switch rejection',
        first.events,
        controlIndex,
        event =>
          event?.type === 'log' &&
          event.log?.message === 'Cannot switch sessions during an active turn',
        5_000,
      )

      const workspaceOperationIndex = second.events.length
      second.ws.send(JSON.stringify({ type: 'fs_read', path: 'package.json' }))
      await waitForEventSince(
        'workspace operation rejection',
        second.events,
        workspaceOperationIndex,
        event =>
          event?.type === 'log' &&
          event.log?.message === 'Workspace is busy with an active turn',
        5_000,
      )

      const httpConflict = await fetch(
        `http://${daemon.host}:${daemon.port}/api/chat?token=${encodeURIComponent(daemon.token)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: secondSessionId,
            prompt: 'http conflict',
          }),
        },
      )
      expect(httpConflict.status).toBe(409)

      second.ws.send(
        JSON.stringify({ type: 'prompt', prompt: 'websocket conflict' }),
      )
      const conflictResult = await waitForEvent(
        'websocket conflict result',
        second.events,
        event => event?.type === 'result' && event.is_error === true,
        5_000,
      )
      expect(conflictResult.subtype).toBe('error_during_execution')

      await waitForEvent(
        'held turn result',
        first.events,
        event => event?.type === 'result' && event.result === 'held turn',
        5_000,
      )

      const retryIndex = second.events.length
      second.ws.send(
        JSON.stringify({ type: 'prompt', prompt: 'accepted after release' }),
      )
      await waitForEventSince(
        'turn accepted after release',
        second.events,
        retryIndex,
        event =>
          event?.type === 'result' && event.result === 'accepted after release',
        5_000,
      )
    } finally {
      if (first) await closeWs(first.ws)
      if (second) await closeWs(second.ws)
      daemon.stop()
    }
  }, 20_000)
})
