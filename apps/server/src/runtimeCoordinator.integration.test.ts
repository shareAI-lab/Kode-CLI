import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket as WsClient } from 'ws'

import {
  getCwd,
  getOriginalCwd,
  setCwd,
  setOriginalCwd,
} from '@kode/core/utils/state'

import { startKodeDaemon, type KodeDaemon } from './server'
import { processDaemonRuntimeCoordinator } from './turnGate'

type DaemonEvent = Record<string, any>

async function waitForEvent(
  events: DaemonEvent[],
  startIndex: number,
  predicate: (event: DaemonEvent) => boolean,
  timeoutMs = 5_000,
): Promise<DaemonEvent> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const event = events.slice(startIndex).find(predicate)
    if (event) return event
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for daemon event after ${startIndex}`)
}

async function openSocket(
  daemon: KodeDaemon,
): Promise<{ ws: WsClient; events: DaemonEvent[] }> {
  const ws = new WsClient(
    `ws://${daemon.host}:${daemon.port}/ws?token=${encodeURIComponent(daemon.token)}`,
  )
  const events: DaemonEvent[] = []
  ws.on('message', data => {
    try {
      events.push(JSON.parse(data.toString()) as DaemonEvent)
    } catch {
      /* no-op */
    }
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  await waitForEvent(
    events,
    0,
    event => event.type === 'system' && event.subtype === 'init',
  )
  return { ws, events }
}

async function closeSocket(ws: WsClient): Promise<void> {
  if (ws.readyState === ws.CLOSED) return
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, 500)
    ws.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
    try {
      ws.close()
    } catch {
      clearTimeout(timer)
      resolve()
    }
  })
}

async function restoreRuntimeCwd(cwd: string, originalCwd: string) {
  await processDaemonRuntimeCoordinator.runStartupExclusive(async () => {
    setOriginalCwd(originalCwd)
    await setCwd(cwd)
  })
}

describe('process-global daemon runtime coordination', () => {
  test('serializes turns and workspace cwd across daemon instances', async () => {
    const runtimeCwd = getCwd()
    const runtimeOriginalCwd = getOriginalCwd()
    const tempRoot = mkdtempSync(join(tmpdir(), 'kode-daemon-runtime-'))
    const firstCwd = join(tempRoot, 'first')
    const secondCwd = join(tempRoot, 'second')
    mkdirSync(firstCwd, { recursive: true })
    mkdirSync(secondCwd, { recursive: true })
    writeFileSync(join(firstCwd, 'marker.txt'), 'first workspace', 'utf8')
    writeFileSync(join(secondCwd, 'marker.txt'), 'second workspace', 'utf8')

    let firstDaemon: KodeDaemon | null = null
    let secondDaemon: KodeDaemon | null = null
    let firstSocket: Awaited<ReturnType<typeof openSocket>> | null = null
    let secondSocket: Awaited<ReturnType<typeof openSocket>> | null = null
    try {
      const daemons = await Promise.all([
        startKodeDaemon({
          cwd: firstCwd,
          port: 0,
          echo: true,
          echoDelayMs: 1_000,
        }),
        startKodeDaemon({
          cwd: secondCwd,
          port: 0,
          echo: true,
        }),
      ])
      firstDaemon = daemons[0]
      secondDaemon = daemons[1]
      firstSocket = await openSocket(firstDaemon)
      secondSocket = await openSocket(secondDaemon)

      const firstReadIndex = firstSocket.events.length
      firstSocket.ws.send(
        JSON.stringify({ type: 'fs_read', path: 'marker.txt' }),
      )
      const firstRead = await waitForEvent(
        firstSocket.events,
        firstReadIndex,
        event => event.type === 'fs_read_result',
      )
      expect(firstRead).toMatchObject({ ok: true, content: 'first workspace' })

      const secondReadIndex = secondSocket.events.length
      secondSocket.ws.send(
        JSON.stringify({ type: 'fs_read', path: 'marker.txt' }),
      )
      const secondRead = await waitForEvent(
        secondSocket.events,
        secondReadIndex,
        event => event.type === 'fs_read_result',
      )
      expect(secondRead).toMatchObject({
        ok: true,
        content: 'second workspace',
      })

      const firstTurnIndex = firstSocket.events.length
      firstSocket.ws.send(
        JSON.stringify({ type: 'prompt', prompt: 'first held turn' }),
      )
      await waitForEvent(
        firstSocket.events,
        firstTurnIndex,
        event => event.type === 'user',
      )

      const blockedIndex = secondSocket.events.length
      secondSocket.ws.send(
        JSON.stringify({ type: 'prompt', prompt: 'must be blocked' }),
      )
      const blocked = await waitForEvent(
        secondSocket.events,
        blockedIndex,
        event => event.type === 'result',
      )
      expect(blocked).toMatchObject({
        is_error: true,
        result: 'Another turn is already active',
      })

      await waitForEvent(
        firstSocket.events,
        firstTurnIndex,
        event => event.type === 'result' && event.result === 'first held turn',
      )
      const retryIndex = secondSocket.events.length
      secondSocket.ws.send(
        JSON.stringify({ type: 'prompt', prompt: 'second retry' }),
      )
      await waitForEvent(
        secondSocket.events,
        retryIndex,
        event => event.type === 'result' && event.result === 'second retry',
      )
    } finally {
      if (firstSocket) await closeSocket(firstSocket.ws)
      if (secondSocket) await closeSocket(secondSocket.ws)
      firstDaemon?.stop()
      secondDaemon?.stop()
      await restoreRuntimeCwd(runtimeCwd, runtimeOriginalCwd)
      rmSync(tempRoot, { recursive: true, force: true })
    }
  }, 20_000)

  test('active stop aborts and drains before a different-cwd restart', async () => {
    const runtimeCwd = getCwd()
    const runtimeOriginalCwd = getOriginalCwd()
    const tempRoot = mkdtempSync(join(tmpdir(), 'kode-daemon-restart-'))
    const oldCwd = join(tempRoot, 'old')
    const newCwd = join(tempRoot, 'new')
    mkdirSync(oldCwd, { recursive: true })
    mkdirSync(newCwd, { recursive: true })
    writeFileSync(join(newCwd, 'marker.txt'), 'new runtime', 'utf8')

    let oldDaemon: KodeDaemon | null = null
    let restarted: KodeDaemon | null = null
    let oldSocket: Awaited<ReturnType<typeof openSocket>> | null = null
    let newSocket: Awaited<ReturnType<typeof openSocket>> | null = null
    try {
      oldDaemon = await startKodeDaemon({
        cwd: oldCwd,
        port: 0,
        echo: true,
        echoDelayMs: 10_000,
      })
      oldSocket = await openSocket(oldDaemon)
      const turnIndex = oldSocket.events.length
      oldSocket.ws.send(
        JSON.stringify({ type: 'prompt', prompt: 'old active turn' }),
      )
      await waitForEvent(
        oldSocket.events,
        turnIndex,
        event => event.type === 'user',
      )

      const restartStartedAt = Date.now()
      oldDaemon.stop()
      oldDaemon.stop()
      restarted = await startKodeDaemon({
        cwd: newCwd,
        port: 0,
        echo: true,
      })
      expect(Date.now() - restartStartedAt).toBeLessThan(4_000)

      newSocket = await openSocket(restarted)
      const readIndex = newSocket.events.length
      newSocket.ws.send(JSON.stringify({ type: 'fs_read', path: 'marker.txt' }))
      const read = await waitForEvent(
        newSocket.events,
        readIndex,
        event => event.type === 'fs_read_result',
      )
      expect(read).toMatchObject({ ok: true, content: 'new runtime' })

      const promptIndex = newSocket.events.length
      newSocket.ws.send(
        JSON.stringify({ type: 'prompt', prompt: 'restart succeeds' }),
      )
      await waitForEvent(
        newSocket.events,
        promptIndex,
        event => event.type === 'result' && event.result === 'restart succeeds',
      )
      expect(getCwd()).toBe(newCwd)
    } finally {
      if (oldSocket) await closeSocket(oldSocket.ws)
      if (newSocket) await closeSocket(newSocket.ws)
      oldDaemon?.stop()
      restarted?.stop()
      await restoreRuntimeCwd(runtimeCwd, runtimeOriginalCwd)
      rmSync(tempRoot, { recursive: true, force: true })
    }
  }, 20_000)
})
