import { describe, expect, mock, test } from 'bun:test'
import { connect } from 'node:net'
import { WebSocketServer } from 'ws'

import { createRoutes } from '../routes'
import { SessionRegistry } from '../sessionRegistry'
import { DaemonTurnGate } from '../turnGate'
import { serveNode, type ServeNodeResult } from './serveNode'

const noopWebSocketHandlers = {
  open: () => {},
  message: () => {},
  close: () => {},
}

function sendRawHttpRequest(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    let response = ''
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error('Timed out waiting for HTTP response'))
    }, 2_000)

    socket.once('connect', () => socket.write(request))
    socket.on('data', chunk => {
      response += chunk.toString('utf8')
    })
    socket.once('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
    socket.once('close', () => {
      clearTimeout(timeout)
      resolve(response)
    })
  })
}

function waitForUpgradeConnectionClose(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const socket = connect({ host: '127.0.0.1', port })
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error('Timed out waiting for failed upgrade to close'))
    }, 2_000)

    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve()
    }

    socket.on('connect', () => {
      socket.write(
        [
          'GET /ws HTTP/1.1',
          `Host: 127.0.0.1:${port}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          '',
          '',
        ].join('\r\n'),
      )
    })
    socket.on('error', () => {})
    socket.on('close', finish)
  })
}

describe('serveNode WebSocket upgrade handling', () => {
  test('closes the transport and releases a route session when handleUpgrade throws', async () => {
    const sessionRegistry = new SessionRegistry()
    const routes = createRoutes({
      webuiRoot: null,
      checkToken: () => true,
      listWorkspaces: async () => ({
        currentId: 'repo',
        workspaces: [
          {
            id: 'repo',
            path: 'C:/repo',
            title: 'repo',
            branch: null,
            isCurrent: true,
          },
        ],
      }),
      sessionRegistry,
      turnGate: new DaemonTurnGate(),
      cwd: 'C:/repo',
      echo: true,
      echoDelayMs: 0,
      commands: [],
      tools: [],
      toolNames: [],
      slashCommands: [],
      mcpClients: [],
    })
    const webSocketServer = new WebSocketServer({ noServer: true })
    const handleUpgrade = mock(() => {
      throw new Error('upgrade crashed')
    })
    Object.defineProperty(webSocketServer, 'handleUpgrade', {
      configurable: true,
      value: handleUpgrade,
    })
    let server: ServeNodeResult | undefined

    try {
      server = await serveNode({
        hostname: '127.0.0.1',
        port: 0,
        fetch: async (request, upgradeServer) => {
          const response = await routes.fetch(request, upgradeServer)
          // Exercise serveNode's destroy fallback after the route has performed
          // its failed-upgrade cleanup.
          return response?.status === 400 ? undefined : response
        },
        websocket: {
          open: () => {},
          message: () => {},
          close: () => {},
        },
        webSocketServer,
      })

      await waitForUpgradeConnectionClose(server.port)

      expect(handleUpgrade).toHaveBeenCalledTimes(1)
      expect(sessionRegistry.size).toBe(0)
    } finally {
      server?.stop(true)
    }
  })
})

describe('serveNode request limits', () => {
  test('rejects invalid configured byte limits', async () => {
    await expect(
      serveNode({
        hostname: '127.0.0.1',
        port: 0,
        maxRequestBodyBytes: 0,
        fetch: () => new Response('unexpected'),
        websocket: noopWebSocketHandlers,
      }),
    ).rejects.toThrow('maxRequestBodyBytes must be a positive integer')
  })

  test('rejects a declared oversized request before invoking the route', async () => {
    let routeCalls = 0
    const server = await serveNode({
      hostname: '127.0.0.1',
      port: 0,
      maxRequestBodyBytes: 32,
      fetch: () => {
        routeCalls += 1
        return new Response('unexpected')
      },
      websocket: noopWebSocketHandlers,
    })

    try {
      const response = await sendRawHttpRequest(
        server.port,
        [
          'POST /oversized HTTP/1.1',
          `Host: 127.0.0.1:${server.port}`,
          'Content-Length: 1024',
          'Connection: close',
          '',
          '',
        ].join('\r\n'),
      )

      expect(response).toContain('413')
      expect(response).toContain('Request body exceeds the size limit')
      expect(routeCalls).toBe(0)
    } finally {
      server.stop(true)
    }
  })

  test('counts chunked request bytes instead of trusting headers', async () => {
    let routeCalls = 0
    const server = await serveNode({
      hostname: '127.0.0.1',
      port: 0,
      maxRequestBodyBytes: 8,
      fetch: () => {
        routeCalls += 1
        return new Response('unexpected')
      },
      websocket: noopWebSocketHandlers,
    })

    try {
      const response = await sendRawHttpRequest(
        server.port,
        [
          'POST /chunked HTTP/1.1',
          `Host: 127.0.0.1:${server.port}`,
          'Transfer-Encoding: chunked',
          'Connection: close',
          '',
          '9',
          '123456789',
          '0',
          '',
          '',
        ].join('\r\n'),
      )

      expect(response).toContain('413')
      expect(response).toContain('Request body exceeds the size limit')
      expect(routeCalls).toBe(0)
    } finally {
      server.stop(true)
    }
  })
})
