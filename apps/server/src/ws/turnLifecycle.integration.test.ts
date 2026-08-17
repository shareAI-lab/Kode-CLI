import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket as WsClient } from 'ws'

import {
  getCwd,
  getOriginalCwd,
  setCwd,
  setOriginalCwd,
} from '@kode/core/utils/state'

import { startKodeDaemon } from '../server'

type DaemonEvent = Record<string, any>

async function openDaemonSocket(daemon: {
  host: string
  port: number
  token: string
}): Promise<{ ws: WsClient; events: DaemonEvent[] }> {
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
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  await waitForEvent(events, 0, event => event.type === 'system')
  return { ws, events }
}

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

async function waitForTurnIdle(
  events: DaemonEvent[],
  startIndex: number,
): Promise<void> {
  await waitForEvent(
    events,
    startIndex,
    event => event.type === 'turn_state' && event.state === 'idle',
  )
}

async function closeSocket(ws: WsClient): Promise<void> {
  if (ws.readyState === ws.CLOSED) return
  await new Promise<void>(resolve => {
    const timer = setTimeout(resolve, 500)
    ws.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
    ws.close()
  })
}

describe('daemon prompt lifecycle over real WebSocket', () => {
  test('cancels a prompt dispatched immediately before cancel', async () => {
    const daemon = await startKodeDaemon({
      cwd: process.cwd(),
      port: 0,
      echo: true,
      echoDelayMs: 500,
    })
    const { ws, events } = await openDaemonSocket(daemon)

    try {
      const startIndex = events.length
      ws.send(JSON.stringify({ type: 'prompt', prompt: 'cancel immediately' }))
      ws.send(JSON.stringify({ type: 'cancel' }))

      const result = await waitForEvent(
        events,
        startIndex,
        event => event.type === 'result',
      )
      await waitForTurnIdle(events, startIndex)
      expect(result).toMatchObject({
        subtype: 'error_during_execution',
        result: '[Request interrupted by user]',
        is_error: true,
      })
      expect(
        events.slice(startIndex).filter(event => event.type === 'result'),
      ).toHaveLength(1)
      expect(
        events
          .slice(startIndex)
          .filter(event => event.type === 'assistant')
          .flatMap(event => event.message?.content ?? [])
          .filter((block: DaemonEvent) => block?.type === 'text')
          .map((block: DaemonEvent) => block.text),
      ).toEqual(['[Request interrupted by user]'])

      const retryIndex = events.length
      ws.send(JSON.stringify({ type: 'prompt', prompt: 'retry succeeds' }))
      const retry = await waitForEvent(
        events,
        retryIndex,
        event => event.type === 'result',
      )
      expect(retry).toMatchObject({
        result: 'retry succeeds',
        is_error: false,
      })
    } finally {
      await closeSocket(ws)
      daemon.stop()
    }
  }, 20_000)

  test('interrupts the echo delay without emitting a success assistant', async () => {
    const daemon = await startKodeDaemon({
      cwd: process.cwd(),
      port: 0,
      echo: true,
      echoDelayMs: 1_000,
    })
    const { ws, events } = await openDaemonSocket(daemon)

    try {
      const startIndex = events.length
      ws.send(JSON.stringify({ type: 'prompt', prompt: 'cancel in delay' }))
      await waitForEvent(events, startIndex, event => event.type === 'user')
      ws.send(JSON.stringify({ type: 'cancel' }))

      const result = await waitForEvent(
        events,
        startIndex,
        event => event.type === 'result',
      )
      await waitForTurnIdle(events, startIndex)
      expect(result).toMatchObject({
        result: '[Request interrupted by user]',
        is_error: true,
      })
      expect(
        events.slice(startIndex).filter(event => event.type === 'result'),
      ).toHaveLength(1)
      expect(
        events
          .slice(startIndex)
          .filter(event => event.type === 'assistant')
          .flatMap(event => event.message?.content ?? [])
          .filter((block: DaemonEvent) => block?.type === 'text')
          .map((block: DaemonEvent) => block.text),
      ).toEqual(['[Request interrupted by user]'])
    } finally {
      await closeSocket(ws)
      daemon.stop()
    }
  }, 20_000)

  test('turn setup errors emit one terminal result and release for retry', async () => {
    const originalCwd = getCwd()
    const originalOriginalCwd = getOriginalCwd()
    const tempRoot = mkdtempSync(join(tmpdir(), 'kode-daemon-setup-error-'))
    const projectDir = join(tempRoot, 'project')
    mkdirSync(projectDir, { recursive: true })
    const daemon = await startKodeDaemon({
      cwd: projectDir,
      port: 0,
      echo: true,
    })
    const { ws, events } = await openDaemonSocket(daemon)

    try {
      rmSync(projectDir, { recursive: true, force: true })
      const startIndex = events.length
      ws.send(JSON.stringify({ type: 'prompt', prompt: 'setup fails' }))

      const result = await waitForEvent(
        events,
        startIndex,
        event => event.type === 'result',
      )
      await waitForTurnIdle(events, startIndex)
      expect(result.is_error).toBe(true)
      expect(String(result.result)).toContain('does not exist')
      expect(
        events.slice(startIndex).filter(event => event.type === 'result'),
      ).toHaveLength(1)

      mkdirSync(projectDir, { recursive: true })
      const retryIndex = events.length
      ws.send(JSON.stringify({ type: 'prompt', prompt: 'setup retry' }))
      const retry = await waitForEvent(
        events,
        retryIndex,
        event => event.type === 'result',
      )
      expect(retry).toMatchObject({ result: 'setup retry', is_error: false })
    } finally {
      await closeSocket(ws)
      daemon.stop()
      await setCwd(originalCwd)
      setOriginalCwd(originalOriginalCwd)
      rmSync(tempRoot, { recursive: true, force: true })
    }
  }, 20_000)
})
