import type { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import {
  LoggingMessageNotificationSchema,
  ResourceUpdatedNotificationSchema,
  type ServerCapabilities,
} from '@modelcontextprotocol/sdk/types.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js'

import {
  checkHasTrustDialogAccepted,
  type McpServerConfig,
} from '#core/utils/config'
import { MACRO } from '#core/constants/macros'
import { PRODUCT_COMMAND } from '#core/constants/product'
import { logMCPError } from '#core/utils/log'
import { getCwd } from '#core/utils/state'

import { notifyMcpListChanged } from './listChanged'
import { handleMcpLoggingMessage } from './logging'
import { notifyMcpResourceUpdated } from './resourceUpdates'
import { getMcpOAuthProvider } from './oauth'
import { getMcpServer } from './config'
import { getMcpServerConnectionBatchSize } from './settings'
import {
  getMcpClientCapabilities,
  registerMcpClientRequestHandlers,
  unregisterMcpClientRequestHandlers,
} from './roots'
import {
  registerMcpSamplingHandler,
  unregisterMcpSamplingHandler,
} from './sampling'
import type { WrappedClient } from './types'

type GlobalWithWebSocket = { WebSocket?: unknown }
export type McpClientConnectionOptions = { clientVersion?: string }

export function getMcpClientInfo(options?: McpClientConnectionOptions): {
  name: string
  version: string
} {
  return {
    name: PRODUCT_COMMAND,
    version: options?.clientVersion ?? MACRO.VERSION,
  }
}

export function createMcpClientSdkOptions(name: string) {
  return {
    capabilities: getMcpClientCapabilities(),
    listChanged: {
      tools: {
        onChanged: (error: Error | null) => {
          if (error) {
            logMCPError(
              name,
              `Failed to refresh tools after list change: ${error.message}`,
            )
            return
          }
          notifyMcpListChanged({ kind: 'tools', server: name })
        },
      },
      prompts: {
        onChanged: (error: Error | null) => {
          if (error) {
            logMCPError(
              name,
              `Failed to refresh prompts after list change: ${error.message}`,
            )
            return
          }
          notifyMcpListChanged({ kind: 'prompts', server: name })
        },
      },
      resources: {
        onChanged: (error: Error | null) => {
          if (error) {
            logMCPError(
              name,
              `Failed to refresh resources after list change: ${error.message}`,
            )
            return
          }
          notifyMcpListChanged({ kind: 'resources', server: name })
        },
      },
    },
  }
}

export function createMcpClient(
  name: string,
  options?: McpClientConnectionOptions,
): Client {
  const client = new Client(
    getMcpClientInfo(options),
    createMcpClientSdkOptions(name),
  )
  registerMcpClientRequestHandlers(client)
  registerMcpSamplingHandler(client)
  client.setNotificationHandler(
    LoggingMessageNotificationSchema,
    notification => {
      handleMcpLoggingMessage(name, notification)
    },
  )
  client.setNotificationHandler(
    ResourceUpdatedNotificationSchema,
    notification => {
      notifyMcpResourceUpdated({
        server: name,
        uri: notification.params.uri,
      })
    },
  )
  return client
}

export async function closeMcpClient(client: Client): Promise<void> {
  unregisterMcpClientRequestHandlers(client)
  unregisterMcpSamplingHandler(client)
  try {
    await client.close()
  } catch {}
}

async function ensureWebSocketGlobal(): Promise<void> {
  const global = globalThis as unknown as GlobalWithWebSocket
  if (typeof global.WebSocket === 'function') return

  try {
    const undiciModule = await import('undici')
    const maybeWs = (undiciModule as unknown as GlobalWithWebSocket).WebSocket
    if (typeof maybeWs === 'function') {
      global.WebSocket = maybeWs
    }
  } catch {
    // ignore
  }
}

function buildStdioEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  if (extra) Object.assign(env, extra)
  return env
}

function buildShellCommand(command: string): string[] {
  if (process.platform === 'win32') {
    return ['cmd.exe', '/d', '/s', '/c', command]
  }
  return ['/bin/sh', '-c', command]
}

async function runShellCommandCaptureOutput(args: {
  command: string
  cwd: string
  timeoutMs: number
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const cmd = buildShellCommand(args.command)

  let proc: ReturnType<typeof spawn>
  try {
    proc = spawn(cmd[0], cmd.slice(1), {
      cwd: args.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
    }
  }

  let stdout = ''
  let stderr = ''

  if (proc.stdout) {
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', chunk => {
      stdout += chunk
    })
  }
  if (proc.stderr) {
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', chunk => {
      stderr += chunk
    })
  }

  const timeoutId =
    args.timeoutMs > 0
      ? setTimeout(() => {
          try {
            proc.kill()
          } catch {}
        }, args.timeoutMs)
      : null

  const exitCode = await new Promise<number>(resolve => {
    proc.once('exit', code => resolve(code ?? 1))
    proc.once('error', () => resolve(2))
  })

  if (timeoutId) clearTimeout(timeoutId)
  return { exitCode, stdout, stderr }
}

function isWorkspaceScopedServer(scope: unknown): boolean {
  return scope === 'project' || scope === 'mcprc' || scope === 'mcpjson'
}

async function getDynamicHeadersFromHelper(args: {
  serverName: string
  helperCommand: string
}): Promise<Record<string, string> | null> {
  const scoped = getMcpServer(args.serverName)
  const scope = scoped?.scope
  if (isWorkspaceScopedServer(scope) && !checkHasTrustDialogAccepted()) {
    logMCPError(
      args.serverName,
      `Security: headersHelper for MCP server "${args.serverName}" executed before workspace trust is confirmed.`,
    )
    return null
  }

  const result = await runShellCommandCaptureOutput({
    command: args.helperCommand,
    cwd: getCwd(),
    timeoutMs: 10_000,
  })

  if (result.exitCode !== 0 || !result.stdout.trim()) {
    logMCPError(
      args.serverName,
      `headersHelper did not return a valid value (exit code ${result.exitCode})`,
    )
    if (result.stderr.trim()) {
      logMCPError(
        args.serverName,
        `headersHelper stderr: ${result.stderr.trim()}`,
      )
    }
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout.trim())
  } catch (err) {
    logMCPError(
      args.serverName,
      `headersHelper returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logMCPError(
      args.serverName,
      'headersHelper must return a JSON object with string key-value pairs',
    )
    return null
  }

  const record = parsed as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== 'string') {
      logMCPError(
        args.serverName,
        `headersHelper returned non-string value for key "${key}": ${typeof value}`,
      )
      return null
    }
    out[key] = value
  }

  return out
}

async function resolveRequestHeaders(
  serverName: string,
  serverRef: McpServerConfig,
): Promise<Record<string, string> | undefined> {
  const staticHeaders =
    'headers' in serverRef && serverRef.headers ? serverRef.headers : null
  const helper =
    'headersHelper' in serverRef && serverRef.headersHelper
      ? serverRef.headersHelper
      : null

  if (!staticHeaders && !helper) return undefined

  const dynamicHeaders = helper
    ? await getDynamicHeadersFromHelper({
        serverName,
        helperCommand: helper,
      })
    : null

  const merged = { ...(staticHeaders ?? {}), ...(dynamicHeaders ?? {}) }
  return Object.keys(merged).length ? merged : undefined
}

export type McpTransportCandidate =
  | { kind: 'stdio'; transport: StdioClientTransport }
  | { kind: 'sse'; transport: SSEClientTransport }
  | { kind: 'http'; transport: StreamableHTTPClientTransport }
  | { kind: 'ws'; transport: WebSocketClientTransport }

export function getMcpConnectionTimeoutMs(): number {
  const rawTimeout = process.env.MCP_CONNECTION_TIMEOUT_MS
  const parsedTimeout = rawTimeout ? Number.parseInt(rawTimeout, 10) : NaN
  return Number.isFinite(parsedTimeout) ? parsedTimeout : 30_000
}

export async function createMcpTransportCandidates(
  nameOrServerRef: string | McpServerConfig,
  maybeServerRef?: McpServerConfig,
): Promise<McpTransportCandidate[]> {
  const name =
    typeof nameOrServerRef === 'string' ? nameOrServerRef : 'mcp-server'
  const serverRef =
    typeof nameOrServerRef === 'string' ? maybeServerRef : nameOrServerRef

  if (!serverRef) {
    throw new Error('MCP server configuration is required')
  }

  switch (serverRef.type) {
    case 'sse': {
      const ref = serverRef
      const authProvider = getMcpOAuthProvider(name)
      const headers = await resolveRequestHeaders(name, ref)
      return [
        {
          kind: 'sse',
          transport: new SSEClientTransport(new URL(ref.url), {
            authProvider,
            ...(headers ? { requestInit: { headers } } : {}),
          }),
        },
        {
          kind: 'http',
          transport: new StreamableHTTPClientTransport(new URL(ref.url), {
            authProvider,
            ...(headers ? { requestInit: { headers } } : {}),
          }),
        },
      ]
    }
    case 'sse-ide': {
      const ref = serverRef
      const authProvider = getMcpOAuthProvider(name)
      const headers = await resolveRequestHeaders(name, ref)
      return [
        {
          kind: 'sse',
          transport: new SSEClientTransport(new URL(ref.url), {
            authProvider,
            ...(headers ? { requestInit: { headers } } : {}),
          }),
        },
      ]
    }
    case 'http': {
      const ref = serverRef
      const authProvider = getMcpOAuthProvider(name)
      const headers = await resolveRequestHeaders(name, ref)
      return [
        {
          kind: 'http',
          transport: new StreamableHTTPClientTransport(new URL(ref.url), {
            authProvider,
            ...(headers ? { requestInit: { headers } } : {}),
          }),
        },
        {
          kind: 'sse',
          transport: new SSEClientTransport(new URL(ref.url), {
            authProvider,
            ...(headers ? { requestInit: { headers } } : {}),
          }),
        },
      ]
    }
    case 'ws': {
      const ref = serverRef
      await ensureWebSocketGlobal()
      return [
        {
          kind: 'ws',
          transport: new WebSocketClientTransport(new URL(ref.url)),
        },
      ]
    }
    case 'ws-ide': {
      const ref = serverRef

      let url = ref.url
      if (ref.authToken) {
        try {
          const parsed = new URL(url)
          if (!parsed.searchParams.has('authToken')) {
            parsed.searchParams.set('authToken', ref.authToken)
            url = parsed.toString()
          }
        } catch {
          // ignore
        }
      }

      await ensureWebSocketGlobal()
      return [
        {
          kind: 'ws',
          transport: new WebSocketClientTransport(new URL(url)),
        },
      ]
    }
    case 'stdio':
    default: {
      const ref = serverRef
      return [
        {
          kind: 'stdio',
          transport: new StdioClientTransport({
            command: ref.command,
            args: ref.args,
            env: buildStdioEnv(ref.env),
            stderr: 'pipe',
          }),
        },
      ]
    }
  }
}

export async function connectToServer(
  name: string,
  serverRef: McpServerConfig,
  options?: McpClientConnectionOptions,
): Promise<Client> {
  const candidates = await createMcpTransportCandidates(name, serverRef)

  const connectionTimeoutMs = getMcpConnectionTimeoutMs()

  let lastError: unknown

  for (const candidate of candidates) {
    const client = createMcpClient(name, options)

    try {
      const connectPromise = client.connect(candidate.transport)
      let timeoutId: ReturnType<typeof setTimeout> | null = null

      try {
        if (connectionTimeoutMs > 0) {
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              reject(
                new Error(
                  `Connection to MCP server "${name}" timed out after ${connectionTimeoutMs}ms`,
                ),
              )
            }, connectionTimeoutMs)
          })

          await Promise.race([connectPromise, timeoutPromise])
        } else {
          await connectPromise
        }
      } finally {
        if (timeoutId) clearTimeout(timeoutId)
      }

      if (candidate.kind === 'stdio') {
        candidate.transport.stderr?.on('data', (data: Buffer) => {
          const errorText = data.toString().trim()
          if (errorText) logMCPError(name, `Server stderr: ${errorText}`)
        })
      }

      if (candidates.length > 1 && candidate !== candidates[0]) {
        logMCPError(
          name,
          `Connected using fallback transport "${candidate.kind}". Consider setting the server type explicitly in your MCP config.`,
        )
      }

      return client
    } catch (error) {
      lastError = error
      await closeMcpClient(client)
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed to connect to MCP server "${name}"`)
}

export function captureMcpCapabilities(
  client: Client,
): ServerCapabilities | null {
  try {
    return client.getServerCapabilities() ?? null
  } catch {
    return null
  }
}

export async function connectMcpServer(
  name: string,
  serverRef: McpServerConfig,
  options?: McpClientConnectionOptions,
): Promise<WrappedClient> {
  try {
    const client = await connectToServer(name, serverRef, options)
    return {
      name,
      client,
      capabilities: captureMcpCapabilities(client),
      type: 'connected',
    }
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      logMCPError(name, 'Connection failed: authentication required')
      return { name, type: 'needs-auth' }
    }
    logMCPError(
      name,
      `Connection failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    return { name, type: 'failed' }
  }
}

export { getMcpServerConnectionBatchSize }
