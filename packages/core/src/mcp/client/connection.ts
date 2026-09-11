import type { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'

import {
  checkHasTrustDialogAccepted,
  type McpServerConfig,
} from '#core/utils/config'
import { PRODUCT_COMMAND } from '#core/constants/product'
import { logMCPError } from '#core/utils/log'
import { getCwd } from '#core/utils/state'

import { notifyMcpListChanged } from './listChanged'
import { getMcpOAuthProvider } from './oauth'
import { getMcpServer } from './config'
import {
  getMcpClientCapabilities,
  registerCapabilityHandlers,
} from './capabilities'
import { createTransportCandidates } from '../transports/registry'

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

export async function connectToServer(
  name: string,
  serverRef: McpServerConfig,
): Promise<Client> {
  // Only HTTP-based transports consume OAuth state and request headers. Doing
  // this unconditionally would create OAuth state files for every stdio server.
  const usesHttpAuth =
    serverRef.type === 'sse' ||
    serverRef.type === 'sse-ide' ||
    serverRef.type === 'http'

  const authProvider = usesHttpAuth ? getMcpOAuthProvider(name) : undefined
  const headers = usesHttpAuth
    ? await resolveRequestHeaders(name, serverRef)
    : undefined

  const candidates = await createTransportCandidates(serverRef, {
    authProvider,
    headers,
  })

  const rawTimeout = process.env.MCP_CONNECTION_TIMEOUT_MS
  const parsedTimeout = rawTimeout ? Number.parseInt(rawTimeout, 10) : NaN
  const connectionTimeoutMs = Number.isFinite(parsedTimeout)
    ? parsedTimeout
    : 30_000

  let lastError: unknown

  for (const candidate of candidates) {
    // One object drives both the advertised capabilities and the handler
    // registration: the SDK refuses a handler for an undeclared capability.
    const capabilities = getMcpClientCapabilities()
    const client = new Client(
      { name: PRODUCT_COMMAND, version: '0.1.0' },
      {
        capabilities,
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
      },
    )

    try {
      registerCapabilityHandlers(client, name, { capabilities })

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
      try {
        await client.close()
      } catch {}
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed to connect to MCP server "${name}"`)
}
