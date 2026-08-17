import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { connect, type Socket } from 'node:net'

import { serveNode, type ServeNodeResult } from './serveNode'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function within<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function runNativeNode(source: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('node', ['--import', 'tsx', '--input-type=module'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let output = ''
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`native Node fallback test timed out\n${output}`))
    }, 4_000)

    child.stdout?.on('data', chunk => {
      output += String(chunk)
    })
    child.stderr?.on('data', chunk => {
      output += String(chunk)
    })
    child.once('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', code => {
      clearTimeout(timeout)
      if (code === 0) resolve()
      else reject(new Error(`native Node fallback test failed\n${output}`))
    })
    child.stdin?.end(source)
  })
}

function openRawHttpSocket(port: number, request: string): Socket {
  const socket = connect({ host: '127.0.0.1', port })
  socket.once('connect', () => socket.write(request))
  return socket
}

function waitForSocketClose(socket: Socket): Promise<void> {
  if (socket.destroyed) return Promise.resolve()
  return new Promise(resolve => {
    socket.once('close', resolve)
    socket.once('error', () => {})
  })
}

const noopWebSocketHandlers = {
  open: () => {},
  message: () => {},
  close: () => {},
}

describe('serveNode streaming response adapter', () => {
  test('forwards the first ReadableStream chunk before the producer releases the second', async () => {
    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    let releaseSecond = () => {}
    let didReleaseSecond = false
    let secondReleased = false
    let server: ServeNodeResult | undefined
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined

    try {
      server = await serveNode({
        hostname: '127.0.0.1',
        port: 0,
        fetch: () => {
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('first '))
              releaseSecond = () => {
                if (didReleaseSecond) return
                didReleaseSecond = true
                secondReleased = true
                controller.enqueue(encoder.encode('second'))
                controller.close()
              }
            },
          })
          return new Response(body, {
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          })
        },
        websocket: noopWebSocketHandlers,
      })

      const responsePromise = fetch(`http://127.0.0.1:${server.port}/stream`)
      // The catch keeps a timeout failure below from becoming an unhandled
      // rejection while finally releases the test producer.
      void responsePromise.catch(() => {})
      const response = await within(
        responsePromise,
        1_000,
        'response headers waited for the unfinished stream',
      )
      reader = response.body?.getReader()
      if (!reader) throw new Error('missing streamed response body')

      const first = await within(
        reader.read(),
        1_000,
        'first stream chunk was buffered until completion',
      )
      expect(first.done).toBe(false)
      expect(decoder.decode(first.value)).toBe('first ')
      expect(secondReleased).toBe(false)

      releaseSecond()
      const second = await within(reader.read(), 1_000, 'missing second chunk')
      expect(second.done).toBe(false)
      expect(decoder.decode(second.value)).toBe('second')
      expect((await reader.read()).done).toBe(true)
    } finally {
      releaseSecond()
      try {
        await reader?.cancel()
      } catch {
        /* no-op */
      }
      server?.stop(true)
    }
  })

  test('aborts the fetch request and cancels its response body after client disconnect', async () => {
    const encoder = new TextEncoder()
    const requestAborted = deferred<void>()
    const bodyCancelled = deferred<void>()
    let requestAbortCount = 0
    let bodyCancelCount = 0
    let server: ServeNodeResult | undefined
    let socket: Socket | undefined

    try {
      server = await serveNode({
        hostname: '127.0.0.1',
        port: 0,
        fetch: request => {
          request.signal.addEventListener(
            'abort',
            () => {
              requestAbortCount += 1
              requestAborted.resolve()
            },
            { once: true },
          )
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('stream is open'))
            },
            cancel() {
              bodyCancelCount += 1
              bodyCancelled.resolve()
            },
          })
          return new Response(body)
        },
        websocket: noopWebSocketHandlers,
      })

      socket = openRawHttpSocket(
        server.port,
        [
          'GET /disconnect HTTP/1.1',
          `Host: 127.0.0.1:${server.port}`,
          '',
          '',
        ].join('\r\n'),
      )
      const firstBytes = deferred<void>()
      socket.once('data', () => firstBytes.resolve())
      socket.once('error', () => {})
      await within(firstBytes.promise, 1_000, 'stream did not start')

      socket.destroy()
      await within(
        requestAborted.promise,
        1_000,
        'client disconnect did not abort the fetch Request signal',
      )
      await within(
        bodyCancelled.promise,
        1_000,
        'client disconnect did not cancel the upstream response body',
      )
      expect(requestAbortCount).toBe(1)
      expect(bodyCancelCount).toBe(1)
    } finally {
      socket?.destroy()
      server?.stop(true)
    }
  })

  test('does not leave lifecycle listeners that abort a completed request', async () => {
    let requestAbortCount = 0
    let server: ServeNodeResult | undefined
    let socket: Socket | undefined

    try {
      server = await serveNode({
        hostname: '127.0.0.1',
        port: 0,
        fetch: request => {
          request.signal.addEventListener(
            'abort',
            () => {
              requestAbortCount += 1
            },
            { once: true },
          )
          return new Response('complete')
        },
        websocket: noopWebSocketHandlers,
      })

      socket = openRawHttpSocket(
        server.port,
        [
          'GET /complete HTTP/1.1',
          `Host: 127.0.0.1:${server.port}`,
          'Connection: close',
          '',
          '',
        ].join('\r\n'),
      )
      let received = ''
      socket.on('data', chunk => {
        received += chunk.toString('utf8')
      })
      socket.once('error', () => {})

      await within(
        waitForSocketClose(socket),
        1_000,
        'completed HTTP connection did not close',
      )
      expect(received).toContain('complete')
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(requestAbortCount).toBe(0)
    } finally {
      socket?.destroy()
      server?.stop(true)
    }
  })

  test('force stop destroys active HTTP sockets and cancels the upstream body', async () => {
    const encoder = new TextEncoder()
    const requestAborted = deferred<void>()
    const bodyCancelled = deferred<void>()
    let requestAbortCount = 0
    let bodyCancelCount = 0
    let server: ServeNodeResult | undefined
    let socket: Socket | undefined

    try {
      server = await serveNode({
        hostname: '127.0.0.1',
        port: 0,
        fetch: request => {
          request.signal.addEventListener(
            'abort',
            () => {
              requestAbortCount += 1
              requestAborted.resolve()
            },
            { once: true },
          )
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('stream remains open'))
            },
            cancel() {
              bodyCancelCount += 1
              bodyCancelled.resolve()
            },
          })
          return new Response(body)
        },
        websocket: noopWebSocketHandlers,
      })

      socket = openRawHttpSocket(
        server.port,
        [
          'GET /force-stop HTTP/1.1',
          `Host: 127.0.0.1:${server.port}`,
          '',
          '',
        ].join('\r\n'),
      )
      const firstBytes = deferred<void>()
      socket.once('data', () => firstBytes.resolve())
      socket.once('error', () => {})

      await within(
        firstBytes.promise,
        1_000,
        'stream did not start before force stop',
      )

      server.stop(true)
      await within(
        waitForSocketClose(socket),
        1_000,
        'force stop did not close the active HTTP socket',
      )
      await within(
        requestAborted.promise,
        1_000,
        'force stop did not abort the fetch Request signal',
      )
      await within(
        bodyCancelled.promise,
        1_000,
        'force stop did not cancel the upstream response body',
      )
      expect(requestAbortCount).toBe(1)
      expect(bodyCancelCount).toBe(1)
    } finally {
      socket?.destroy()
      server?.stop(true)
    }
  })

  test('streams upgrade fallbacks with the native Node runtime', async () => {
    const serveNodeModuleUrl = new URL('./serveNode.ts', import.meta.url).href

    await runNativeNode(`
      import { connect } from 'node:net'
      import { serveNode } from ${JSON.stringify(serveNodeModuleUrl)}

      const encoder = new TextEncoder()
      let releaseSecond = () => {}
      const server = await serveNode({
        hostname: '127.0.0.1',
        port: 0,
        fetch: () => new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('first '))
            releaseSecond = () => {
              controller.enqueue(encoder.encode('second'))
              controller.close()
            }
          },
        }), { headers: { connection: 'keep-alive' } }),
        websocket: { open() {}, message() {}, close() {} },
      })

      const socket = connect({ host: '127.0.0.1', port: server.port })
      let received = ''
      let released = false
      const done = new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('upgrade fallback timed out')),
          1_500,
        )
        socket.on('connect', () => {
          socket.write([
            'GET /ws HTTP/1.1',
            'Host: 127.0.0.1:' + server.port,
            'Connection: Upgrade',
            'Upgrade: websocket',
            'Sec-WebSocket-Version: 13',
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
            '',
            '',
          ].join('\\r\\n'))
        })
        socket.on('data', chunk => {
          received += chunk.toString('utf8')
          if (!released && received.includes('first ')) {
            released = true
            releaseSecond()
          }
        })
        socket.on('close', () => {
          clearTimeout(timeout)
          const headers = received.toLowerCase()
          if (
            !released ||
            !received.includes('second') ||
            !headers.includes('connection: close') ||
            !headers.includes('transfer-encoding: chunked')
          ) {
            reject(new Error('incomplete upgrade fallback response: ' + received))
            return
          }
          resolve()
        })
        socket.on('error', reject)
      })

      try {
        await done
      } finally {
        socket.destroy()
        server.stop(true)
      }
    `)
  })
})
