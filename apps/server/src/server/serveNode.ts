import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'

type ServeNodeFetchServer<TData> = {
  upgrade: (req: Request, options: { data: TData }) => boolean
}

export type ServeNodeWebSocketServer = Pick<
  WebSocketServer,
  'handleUpgrade' | 'clients' | 'close'
>

export type ServeNodeOptions<TData> = {
  hostname: string
  port: number
  maxRequestBodyBytes?: number
  maxWebSocketMessageBytes?: number
  fetch: (
    req: Request,
    server: ServeNodeFetchServer<TData>,
  ) => Response | Promise<Response | undefined> | undefined
  websocket: {
    open: (ws: WebSocket & { data: TData }) => void
    message: (
      ws: WebSocket & { data: TData },
      message: RawData,
    ) => void | Promise<void>
    close: (ws: WebSocket & { data: TData }) => void
  }
  webSocketServer?: ServeNodeWebSocketServer
}

export type ServeNodeResult = {
  port: number
  stop: (force?: boolean) => void
}

export const DEFAULT_MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024
export const DEFAULT_MAX_WEBSOCKET_MESSAGE_BYTES = 16 * 1024 * 1024
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
export const DEFAULT_HEADERS_TIMEOUT_MS = 15_000

class RequestBodyTooLargeError extends Error {
  constructor() {
    super('Request body too large')
    this.name = 'RequestBodyTooLargeError'
  }
}

function positiveByteLimit(
  name: 'maxRequestBodyBytes' | 'maxWebSocketMessageBytes',
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback
  if (Number.isSafeInteger(value) && value > 0) return value
  throw new Error(`${name} must be a positive integer`)
}

async function readRequestBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<ArrayBuffer | undefined> {
  const method = req.method ?? 'GET'
  if (method === 'GET' || method === 'HEAD') return undefined

  const declaredLength = req.headers['content-length']
  if (typeof declaredLength === 'string') {
    const parsedLength = Number(declaredLength)
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      throw new RequestBodyTooLargeError()
    }
  }

  return await new Promise<ArrayBuffer | undefined>((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalBytes = 0
    let settled = false

    const cleanup = () => {
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('aborted', onAborted)
      req.removeListener('error', onError)
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onData = (chunk: Buffer | string) => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      totalBytes += buffer.byteLength
      if (totalBytes > maxBytes) {
        // Stop consuming attacker-controlled bytes while preserving the socket
        // long enough to send a deterministic 413 response.
        req.pause()
        fail(new RequestBodyTooLargeError())
        return
      }
      chunks.push(buffer)
    }
    const onEnd = () => {
      if (settled) return
      settled = true
      cleanup()
      if (chunks.length === 0) {
        resolve(undefined)
        return
      }
      const buffer = Buffer.concat(chunks, totalBytes)
      resolve(
        buffer.buffer.slice(
          buffer.byteOffset,
          buffer.byteOffset + buffer.byteLength,
        ),
      )
    }
    const onAborted = () => fail(new Error('Request aborted'))
    const onError = (error: Error) => fail(error)

    req.on('data', onData)
    req.once('end', onEnd)
    req.once('aborted', onAborted)
    req.once('error', onError)
  })
}

async function toFetchRequest(
  req: IncomingMessage,
  hostname: string,
  maxRequestBodyBytes: number,
  signal?: AbortSignal,
): Promise<Request> {
  const base = `http://${req.headers.host ?? hostname}`
  const url = new URL(req.url ?? '/', base)
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(key, value)
    else if (Array.isArray(value)) headers.set(key, value.join(', '))
  }
  const body = await readRequestBody(req, maxRequestBodyBytes)
  return new Request(url.toString(), {
    method: req.method ?? 'GET',
    headers,
    signal,
    ...(body ? { body } : {}),
  })
}

type RequestAbortScope = {
  signal: AbortSignal
  cleanup: () => void
}

function createRequestAbortScope(args: {
  req: IncomingMessage
  res?: ServerResponse
  socket?: Duplex
}): RequestAbortScope {
  const controller = new AbortController()
  const abort = () => {
    if (!controller.signal.aborted) controller.abort()
  }
  const onRequestClose = () => {
    if (args.req.aborted || (!args.req.complete && args.req.destroyed)) abort()
  }
  const onResponseClose = () => {
    if (!args.res?.writableEnded) abort()
  }

  // For upgrade requests, the raw socket is the authoritative lifecycle
  // signal. IncomingMessage may emit lifecycle events as the HTTP upgrade
  // completes, even while the upgraded socket remains usable.
  if (args.res) {
    args.req.once('aborted', abort)
    args.req.once('close', onRequestClose)
  }
  args.res?.once('close', onResponseClose)
  args.res?.once('error', abort)
  args.socket?.once('close', abort)
  args.socket?.once('error', abort)

  return {
    signal: controller.signal,
    cleanup: () => {
      if (args.res) {
        args.req.removeListener('aborted', abort)
        args.req.removeListener('close', onRequestClose)
      }
      args.res?.removeListener('close', onResponseClose)
      args.res?.removeListener('error', abort)
      args.socket?.removeListener('close', abort)
      args.socket?.removeListener('error', abort)
    },
  }
}

async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  try {
    await reader.cancel()
  } catch {
    // Cancellation is best-effort after the consumer has already stopped.
  }
}

async function pipeResponseBody(args: {
  body: ReadableStream<Uint8Array>
  signal: AbortSignal
  write: (chunk: Uint8Array) => Promise<void>
}): Promise<void> {
  const reader = args.body.getReader()
  let didCancel = false
  const cancel = () => {
    if (didCancel) return
    didCancel = true
    void cancelReader(reader)
  }
  const onAbort = () => cancel()

  if (args.signal.aborted) cancel()
  else args.signal.addEventListener('abort', onAbort, { once: true })

  try {
    while (!args.signal.aborted) {
      const { done, value } = await reader.read()
      if (done) return
      if (!value || value.byteLength === 0) continue
      await args.write(value)
    }
  } catch (error) {
    cancel()
    if (!args.signal.aborted) throw error
  } finally {
    args.signal.removeEventListener('abort', onAbort)
    if (args.signal.aborted) cancel()
    try {
      reader.releaseLock()
    } catch {
      // A cancelled stream may have released its reader already.
    }
  }
}

async function writeToResponse(
  res: ServerResponse,
  chunk: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || res.destroyed || res.writableEnded) {
    throw new Error('HTTP response closed')
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      res.removeListener('drain', onDrain)
      res.removeListener('error', onError)
      res.removeListener('close', onClose)
      signal.removeEventListener('abort', onAbort)
    }
    const finish = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onDrain = () => finish()
    const onError = (error: Error) => fail(error)
    const onClose = () => fail(new Error('HTTP response closed'))
    const onAbort = () => fail(new Error('HTTP response aborted'))

    res.once('error', onError)
    res.once('close', onClose)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      if (res.write(Buffer.from(chunk))) finish()
      else res.once('drain', onDrain)
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

async function writeToSocket(
  socket: Duplex,
  chunk: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || socket.destroyed || socket.writableEnded) {
    throw new Error('HTTP upgrade socket closed')
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      socket.removeListener('drain', onDrain)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
      signal.removeEventListener('abort', onAbort)
    }
    const finish = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onDrain = () => finish()
    const onError = (error: Error) => fail(error)
    const onClose = () => fail(new Error('HTTP upgrade socket closed'))
    const onAbort = () => fail(new Error('HTTP upgrade socket aborted'))

    socket.once('error', onError)
    socket.once('close', onClose)
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      if (socket.write(Buffer.from(chunk))) finish()
      else socket.once('drain', onDrain)
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

async function cancelResponseBody(
  response: Response | undefined,
): Promise<void> {
  try {
    await response?.body?.cancel()
  } catch {
    // The transport is already closing; cancellation is best-effort.
  }
}

async function sendFetchResponse(
  res: ServerResponse,
  response: Response,
  signal: AbortSignal,
): Promise<void> {
  res.statusCode = response.status
  for (const [key, value] of response.headers.entries()) {
    try {
      res.setHeader(key, value)
    } catch {
      // Ignore a malformed upstream header without failing the whole response.
    }
  }

  if (!response.body || res.req?.method === 'HEAD') {
    await cancelResponseBody(response)
    res.end()
    return
  }

  await pipeResponseBody({
    body: response.body,
    signal,
    write: chunk => writeToResponse(res, chunk, signal),
  })
  if (!res.destroyed && !res.writableEnded) res.end()
}

async function sendFetchResponseToSocket(
  socket: Duplex,
  response: Response,
  signal: AbortSignal,
  requestMethod: string,
): Promise<void> {
  const headers: string[] = []
  for (const [key, value] of response.headers.entries()) {
    // The fallback always closes this raw socket. Do not forward an upstream
    // connection policy or transfer framing that conflicts with that behavior.
    if (key === 'connection' || key === 'transfer-encoding') continue
    headers.push(`${key}: ${value}`)
  }
  headers.push('connection: close')

  const shouldSendBody = Boolean(response.body) && requestMethod !== 'HEAD'
  const hasContentLength = response.headers.has('content-length')
  const usesChunkedEncoding = shouldSendBody && !hasContentLength
  if (usesChunkedEncoding) {
    headers.push('transfer-encoding: chunked')
  }

  const statusText = response.statusText || 'OK'
  await writeToSocket(
    socket,
    Buffer.from(
      `HTTP/1.1 ${response.status} ${statusText}\r\n${headers.join('\r\n')}\r\n\r\n`,
    ),
    signal,
  )
  if (!shouldSendBody || !response.body) {
    await cancelResponseBody(response)
    if (!socket.destroyed && !socket.writableEnded) socket.end()
    return
  }

  await pipeResponseBody({
    body: response.body,
    signal,
    write: async chunk => {
      if (usesChunkedEncoding) {
        await writeToSocket(
          socket,
          Buffer.from(`${chunk.byteLength.toString(16)}\r\n`),
          signal,
        )
        await writeToSocket(socket, chunk, signal)
        await writeToSocket(socket, Buffer.from('\r\n'), signal)
        return
      }
      await writeToSocket(socket, chunk, signal)
    },
  })
  if (!socket.destroyed && !socket.writableEnded) {
    if (usesChunkedEncoding) {
      await writeToSocket(socket, Buffer.from('0\r\n\r\n'), signal)
    }
    socket.end()
  }
}

export async function serveNode<TData>(
  options: ServeNodeOptions<TData>,
): Promise<ServeNodeResult> {
  const maxRequestBodyBytes = positiveByteLimit(
    'maxRequestBodyBytes',
    options.maxRequestBodyBytes,
    DEFAULT_MAX_REQUEST_BODY_BYTES,
  )
  const maxWebSocketMessageBytes = positiveByteLimit(
    'maxWebSocketMessageBytes',
    options.maxWebSocketMessageBytes,
    DEFAULT_MAX_WEBSOCKET_MESSAGE_BYTES,
  )
  const wss =
    options.webSocketServer ??
    new WebSocketServer({
      noServer: true,
      maxPayload: maxWebSocketMessageBytes,
    })
  const sockets = new Set<Duplex>()

  const httpServer = createServer(async (req, res) => {
    const abortScope = createRequestAbortScope({ req, res })
    try {
      const request = await toFetchRequest(
        req,
        options.hostname,
        maxRequestBodyBytes,
        abortScope.signal,
      )
      if (abortScope.signal.aborted) return

      const response = await options.fetch(request, { upgrade: () => false })
      if (abortScope.signal.aborted) {
        await cancelResponseBody(response)
        return
      }
      if (!response) {
        res.statusCode = 500
        res.end('No response')
        return
      }
      await sendFetchResponse(res, response, abortScope.signal)
    } catch (error) {
      if (!res.destroyed && !res.writableEnded) {
        if (error instanceof RequestBodyTooLargeError) {
          res.statusCode = 413
          res.shouldKeepAlive = false
          res.setHeader('connection', 'close')
          res.setHeader('content-type', 'application/json')
          res.end(
            JSON.stringify({ error: 'Request body exceeds the size limit' }),
          )
        } else if (!abortScope.signal.aborted) {
          res.statusCode = 500
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ error: 'Internal server error' }))
        }
      }
    } finally {
      abortScope.cleanup()
    }
  })
  httpServer.requestTimeout = DEFAULT_REQUEST_TIMEOUT_MS
  httpServer.headersTimeout = DEFAULT_HEADERS_TIMEOUT_MS
  httpServer.keepAliveTimeout = 5_000
  httpServer.maxHeadersCount = 100

  httpServer.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })

  httpServer.on('upgrade', (req, socket, head) => {
    void (async () => {
      const abortScope = createRequestAbortScope({ req, socket })
      try {
        const request = await toFetchRequest(
          req,
          options.hostname,
          maxRequestBodyBytes,
          abortScope.signal,
        )
        if (abortScope.signal.aborted) return

        let upgradeState: 'pending' | 'upgrading' | 'upgraded' | 'failed' =
          'pending'
        const didUpgrade = () => upgradeState === 'upgraded'

        const response = await options.fetch(request, {
          upgrade: (_request, upgradeOptions) => {
            if (didUpgrade()) return true
            if (upgradeState !== 'pending' || abortScope.signal.aborted) {
              return false
            }

            upgradeState = 'upgrading'
            let accepted = false
            try {
              wss.handleUpgrade(req, socket, head, ws => {
                const wsWithData = Object.assign(ws, {
                  data: upgradeOptions.data,
                })

                ws.on('message', message => {
                  Promise.resolve(
                    options.websocket.message(wsWithData, message),
                  ).catch(() => {})
                })
                ws.on('close', () => {
                  try {
                    options.websocket.close(wsWithData)
                  } catch {
                    // User cleanup must not crash the transport close handler.
                  }
                })

                accepted = true
                upgradeState = 'upgraded'
                try {
                  options.websocket.open(wsWithData)
                } catch {
                  // The socket lifecycle remains valid if user setup fails.
                }
              })
            } catch {
              upgradeState = 'failed'
              return false
            }

            if (!accepted) {
              upgradeState = 'failed'
              return false
            }
            return true
          },
        })

        if (didUpgrade()) {
          await cancelResponseBody(response)
          return
        }
        if (abortScope.signal.aborted) {
          await cancelResponseBody(response)
          return
        }
        if (response) {
          await sendFetchResponseToSocket(
            socket,
            response,
            abortScope.signal,
            req.method ?? 'GET',
          )
          return
        }
        socket.destroy()
      } catch {
        if (!socket.destroyed) socket.destroy()
      } finally {
        abortScope.cleanup()
      }
    })()
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      reject(err)
    }
    httpServer.once('error', onError)
    httpServer.listen(options.port, options.hostname, () => {
      httpServer.removeListener('error', onError)
      resolve()
    })
  })

  const address = httpServer.address()
  const actualPort =
    typeof address === 'object' && address && typeof address.port === 'number'
      ? address.port
      : options.port

  const stop = (force?: boolean) => {
    try {
      wss.clients.forEach(ws => {
        try {
          ws.close()
        } catch {
          // Continue closing the remaining sockets.
        }
      })
    } catch {
      // A custom WebSocket server may already be closed.
    }
    try {
      wss.close()
    } catch {
      // Stop is idempotent.
    }
    if (force) {
      for (const socket of sockets) {
        try {
          socket.destroy()
        } catch {
          // Continue destroying the remaining sockets.
        }
      }
      sockets.clear()
    }
    try {
      httpServer.close()
    } catch {
      // Stop is idempotent.
    }
  }

  return { port: actualPort, stop }
}
