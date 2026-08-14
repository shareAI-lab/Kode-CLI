import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'

import {
  appendExternalRuntimeStderr,
  formatExternalRuntimeCloseMessage,
} from './diagnostics'

const require = createRequire(import.meta.url)
const INITIALIZE_REQUEST_ID = 1
const MAX_STDOUT_BYTES = 1024 * 1024
const REQUEST_TIMEOUT_MS = 60_000

type JsonRpcMessage = {
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { message?: unknown }
}

type PendingRequest = {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

export class GrokAcpRuntimeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GrokAcpRuntimeError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getOAuthAuthenticationMethod(initializationResult: unknown): string {
  if (!isRecord(initializationResult)) {
    throw new Error('Grok ACP did not return authentication methods')
  }
  const methods = Array.isArray(initializationResult.authMethods)
    ? initializationResult.authMethods
    : []
  const ids = methods.flatMap(method =>
    isRecord(method) && typeof method.id === 'string' ? [method.id] : [],
  )
  // The official runtime has used both names across releases. Prefer the
  // cached OAuth token and do not silently fall back to an API-key method.
  const methodId = ids.includes('cached_token')
    ? 'cached_token'
    : ids.includes('grok.com')
      ? 'grok.com'
      : null
  if (!methodId) {
    throw new Error(
      'Grok ACP does not expose a cached OAuth authentication method',
    )
  }
  return methodId
}

function getGrokCommand(): { command: string; args: string[] } {
  try {
    return {
      command: process.execPath,
      args: [
        require.resolve('@xai-official/grok/bin/grok'),
        '--no-auto-update',
        'agent',
        'stdio',
      ],
    }
  } catch {
    return {
      command: process.platform === 'win32' ? 'grok.cmd' : 'grok',
      args: ['--no-auto-update', 'agent', 'stdio'],
    }
  }
}

/**
 * The official Grok Build CLI exposes ACP over stdio. This transport is kept
 * credential-blind: `authenticate` asks the CLI to reuse its own OAuth state.
 */
export class GrokAcpClient {
  private child: ChildProcess | null = null
  private buffer = ''
  private stderr = ''
  private stdoutBytes = 0
  private nextRequestId = 2
  private readonly pending = new Map<number, PendingRequest>()
  private initialized = false
  private initializationResult: unknown

  constructor(
    private readonly handlers: {
      onNotification?: (method: string, params: unknown) => void
      onServerRequest?: (
        id: number | string,
        method: string,
        params: unknown,
      ) => void
    } = {},
  ) {}

  async start(): Promise<void> {
    if (this.child) return
    this.buffer = ''
    this.stderr = ''
    this.stdoutBytes = 0
    const command = getGrokCommand()
    const child = spawn(command.command, command.args, {
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', chunk => this.handleOutput(chunk))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', chunk => {
      this.stderr = appendExternalRuntimeStderr(this.stderr, chunk)
    })
    child.once('error', error =>
      this.failAll(
        new GrokAcpRuntimeError(
          formatExternalRuntimeCloseMessage(
            `Grok ACP runtime failed: ${error.message}`,
            this.stderr,
          ),
        ),
      ),
    )
    child.once('close', () => {
      if (this.child === child) this.child = null
      this.failAll(
        new GrokAcpRuntimeError(
          formatExternalRuntimeCloseMessage('Grok ACP runtime', this.stderr),
        ),
      )
    })

    try {
      this.initializationResult = await this.requestWithId(
        INITIALIZE_REQUEST_ID,
        'initialize',
        {
          protocolVersion: 1,
          clientCapabilities: {},
        },
      )
      this.initialized = true
      // The official runtime obtains the cached token itself, so Kode never
      // reads ~/.grok/auth.json or falls back to an API-key authentication.
      await this.request('authenticate', {
        methodId: getOAuthAuthenticationMethod(this.initializationResult),
        _meta: { headless: true },
      })
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.initialized)
      throw new Error('Grok ACP runtime is not initialized')
    return this.requestWithId(this.nextRequestId++, method, params)
  }

  /**
   * Returns the capability catalog reported by the official runtime during
   * initialization. It contains no OAuth credential material.
   */
  getInitializationResult(): unknown {
    return this.initializationResult
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.write({ method, params })
  }

  respondError(id: number | string, message: string): void {
    this.write({ id, error: { code: -32601, message } })
  }

  async stop(): Promise<void> {
    const child = this.child
    this.child = null
    this.initialized = false
    this.initializationResult = undefined
    if (!child) return
    this.failAll(new Error('Grok ACP runtime was stopped'))
    if (!child.killed) child.kill()
  }

  private requestWithId(
    id: number,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Grok ACP timed out while calling ${method}`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timeout })
      try {
        this.write({ id, method, params })
      } catch (error) {
        clearTimeout(timeout)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private write(message: Record<string, unknown>): void {
    if (!this.child?.stdin || this.child.stdin.destroyed) {
      throw new Error('Grok ACP input is unavailable')
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private handleOutput(chunk: string): void {
    this.stdoutBytes += Buffer.byteLength(chunk)
    if (this.stdoutBytes > MAX_STDOUT_BYTES) {
      this.failAll(new Error('Grok ACP runtime produced too much output'))
      void this.stop()
      return
    }
    this.buffer += chunk
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      let message: JsonRpcMessage
      try {
        const parsed: unknown = JSON.parse(line)
        if (!isRecord(parsed)) throw new Error('Invalid JSON-RPC message')
        message = parsed
      } catch {
        this.failAll(new Error('Grok ACP emitted invalid JSON-RPC'))
        void this.stop()
        return
      }
      if (
        message.id !== undefined &&
        (message.result !== undefined || message.error)
      ) {
        const id = typeof message.id === 'number' ? message.id : Number.NaN
        const pending = this.pending.get(id)
        if (!pending) continue
        this.pending.delete(id)
        clearTimeout(pending.timeout)
        if (message.error) {
          pending.reject(
            new Error(
              typeof message.error.message === 'string'
                ? message.error.message
                : 'Grok ACP request failed',
            ),
          )
        } else {
          pending.resolve(message.result)
        }
        continue
      }
      if (message.id !== undefined && typeof message.method === 'string') {
        this.handlers.onServerRequest?.(
          message.id,
          message.method,
          message.params,
        )
      } else if (typeof message.method === 'string') {
        this.handlers.onNotification?.(message.method, message.params)
      }
    }
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
  }
}
