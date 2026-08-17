import type { AgentEvent } from '#protocol/agentEvent'
import { AgentEventSchema } from '#protocol/agentEvent'

type WebSocketLike = {
  readyState: number
  send: (data: string) => void
  close: () => void
  addEventListener: (
    type: string,
    listener: (ev: unknown) => void,
    options?: unknown,
  ) => void
  removeEventListener?: (type: string, listener: (ev: unknown) => void) => void
}

type WebSocketCtor = new (url: string) => WebSocketLike

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  return value as Record<string, unknown>
}

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

function getGlobalWebSocketCtor(): WebSocketCtor | null {
  const ws = asRecord(globalThis)?.WebSocket
  return typeof ws === 'function' ? (ws as unknown as WebSocketCtor) : null
}

function isBrowserRuntime(): boolean {
  const maybeWindow = asRecord(globalThis)?.window
  if (!maybeWindow) return false
  return typeof maybeWindow === 'object' && maybeWindow !== null
}

async function getWebSocketImpl(): Promise<WebSocketCtor> {
  // In browsers, prefer the global WebSocket.
  if (isBrowserRuntime()) {
    const globalWebSocket = getGlobalWebSocketCtor()
    if (globalWebSocket) return globalWebSocket
    throw new Error('No WebSocket implementation available')
  }

  // In non-browser runtimes (Node/Bun tests), prefer stable userland implementations.
  try {
    const undici = await import('undici')
    const ws = asRecord(undici)?.WebSocket
    if (typeof ws === 'function') return ws as unknown as WebSocketCtor
  } catch {
    /* no-op */
  }

  try {
    const wsPkg = await import('ws')
    const ws = asRecord(wsPkg)?.WebSocket
    if (typeof ws === 'function') return ws as unknown as WebSocketCtor
    const fallbackDefault = (wsPkg as unknown as { default?: unknown }).default
    if (typeof fallbackDefault === 'function')
      return fallbackDefault as WebSocketCtor
  } catch {
    /* no-op */
  }

  const globalWebSocket = getGlobalWebSocketCtor()
  if (globalWebSocket) return globalWebSocket

  throw new Error('No WebSocket implementation available')
}

class AsyncQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  private items: T[] = []
  private resolvers: Array<(value: IteratorResult<T>) => void> = []
  private closed = false

  private static doneResult<T>(): IteratorResult<T> {
    return { value: undefined as unknown as T, done: true }
  }

  push(item: T) {
    if (this.closed) return
    const resolve = this.resolvers.shift()
    if (resolve) {
      resolve({ value: item, done: false })
      return
    }
    this.items.push(item)
  }

  close() {
    if (this.closed) return
    this.closed = true
    while (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!
      resolve(AsyncQueue.doneResult())
    }
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) {
      return { value: this.items.shift()!, done: false }
    }
    if (this.closed) return AsyncQueue.doneResult()
    return await new Promise<IteratorResult<T>>(resolve => {
      this.resolvers.push(resolve)
    })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this
  }
}

export type KodeDaemonClient = {
  connect: (options?: { timeoutMs?: number }) => Promise<void>
  sendPrompt: (prompt: string) => void
  cancel: () => void
  events: AsyncIterable<AgentEvent>
  close: () => void
  wsUrl: string
}

export function createKodeDaemonClient(args: {
  url: string
  token?: string
}): KodeDaemonClient {
  const base = new URL(args.url)
  const token = args.token ?? base.searchParams.get('token') ?? ''
  if (!token) {
    throw new Error('Missing daemon token (pass ?token= or token option)')
  }

  const wsUrl = new URL(args.url)
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  wsUrl.pathname = '/ws'
  wsUrl.searchParams.set('token', token)

  const queue = new AsyncQueue<AgentEvent>()
  let ws: WebSocketLike | null = null

  const connect = async (options?: { timeoutMs?: number }) => {
    if (ws && ws.readyState === 1) return
    const WebSocketImpl = await getWebSocketImpl()
    const socket: WebSocketLike = new WebSocketImpl(wsUrl.toString())
    ws = socket

    const timeoutMs = options?.timeoutMs ?? 5_000
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup()
        resolve()
      }
      const onError = () => {
        cleanup()
        reject(new Error('WebSocket connection error'))
      }

      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('WebSocket connect timeout'))
      }, timeoutMs)

      const cleanup = () => {
        clearTimeout(timer)
        try {
          socket.removeEventListener?.('open', onOpen)
          socket.removeEventListener?.('error', onError)
        } catch {
          /* no-op */
        }
      }

      socket.addEventListener('open', onOpen, { once: true })
      socket.addEventListener('error', onError, { once: true })
    })

    socket.addEventListener('message', (ev: unknown) => {
      const text = decodeWsMessageData(asRecord(ev)?.data ?? ev)
      try {
        const parsed = JSON.parse(text)
        const validated = AgentEventSchema.safeParse(parsed)
        if (validated.success) queue.push(validated.data)
      } catch {
        // ignore
      }
    })

    socket.addEventListener('close', () => {
      queue.close()
    })
  }

  const sendPrompt = (prompt: string) => {
    if (!ws || ws.readyState !== 1) {
      throw new Error('Daemon client is not connected')
    }
    ws.send(JSON.stringify({ type: 'prompt', prompt }))
  }

  const cancel = () => {
    if (!ws || ws.readyState !== 1) return
    ws.send(JSON.stringify({ type: 'cancel' }))
  }

  const close = () => {
    try {
      ws?.close()
    } catch {
      /* no-op */
    }
    queue.close()
  }

  return {
    connect,
    sendPrompt,
    cancel,
    events: queue,
    close,
    wsUrl: wsUrl.toString(),
  }
}
