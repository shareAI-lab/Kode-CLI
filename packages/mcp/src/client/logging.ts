import type {
  LoggingLevel,
  LoggingMessageNotification,
} from '@modelcontextprotocol/sdk/types.js'

import { addNotification, type InAppNotificationKind } from '@kode/runtime'
import { logMCPError } from '@kode/logging/log/errors'

import { getClients } from './clients'
import type { ConnectedClient, WrappedClient } from './types'

export type McpLoggingLevel = LoggingLevel
export type McpLogMessageEvent = {
  server: string
  level: McpLoggingLevel
  logger?: string
  data: unknown
}

type Listener = (event: McpLogMessageEvent) => void

const listeners = new Set<Listener>()
export const MCP_LOGGING_LEVELS = [
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
  'alert',
  'emergency',
] as const satisfies readonly McpLoggingLevel[]
const MAX_DISPLAY_CHARS = 500
const SENSITIVE_KEY_PATTERN =
  /(?:api[_-]?key|authorization|cookie|credential|password|secret|token)/i

function getCapabilities(client: ConnectedClient) {
  if (client.capabilities) return client.capabilities
  try {
    return client.client.getServerCapabilities() ?? null
  } catch {
    return null
  }
}

async function findLoggingClient(server: string): Promise<ConnectedClient> {
  const clients = await getClients()
  const match = clients.find((client: WrappedClient) => client.name === server)
  if (!match) {
    throw new Error(
      `Server "${server}" not found. Available servers: ${clients.map(c => c.name).join(', ')}`,
    )
  }
  if (match.type !== 'connected') {
    throw new Error(`Server "${server}" is not connected`)
  }

  const capabilities = getCapabilities(match)
  if (!capabilities?.logging) {
    throw new Error(`Server "${server}" does not support logging`)
  }

  return match
}

function truncate(value: string): string {
  if (value.length <= MAX_DISPLAY_CHARS) return value
  return `${value.slice(0, MAX_DISPLAY_CHARS - 3)}...`
}

function redactSensitiveKeys(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(redactSensitiveKeys)

  const redacted: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    redacted[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? '[redacted]'
      : redactSensitiveKeys(item)
  }
  return redacted
}

function formatLogData(data: unknown): string {
  if (typeof data === 'string') return truncate(data)
  if (data === undefined) return ''

  try {
    return truncate(JSON.stringify(redactSensitiveKeys(data)))
  } catch {
    return truncate(String(data))
  }
}

function notificationKindForLevel(
  level: McpLoggingLevel,
): InAppNotificationKind {
  switch (level) {
    case 'emergency':
    case 'alert':
    case 'critical':
    case 'error':
      return 'error'
    case 'warning':
      return 'warning'
    default:
      return 'info'
  }
}

function shouldShowNotification(level: McpLoggingLevel): boolean {
  return (
    level === 'notice' ||
    level === 'warning' ||
    level === 'error' ||
    level === 'critical' ||
    level === 'alert' ||
    level === 'emergency'
  )
}

function shouldPersistToMcpLog(level: McpLoggingLevel): boolean {
  return (
    level === 'warning' ||
    level === 'error' ||
    level === 'critical' ||
    level === 'alert' ||
    level === 'emergency'
  )
}

export function subscribeMcpLogMessage(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export async function setMcpLoggingLevel({
  server,
  level,
}: {
  server: string
  level: McpLoggingLevel
}): Promise<void> {
  const match = await findLoggingClient(server)
  await match.client.setLoggingLevel(level)
}

export function handleMcpLoggingMessage(
  server: string,
  notification: LoggingMessageNotification,
): void {
  const event: McpLogMessageEvent = {
    server,
    level: notification.params.level,
    logger: notification.params.logger,
    data: notification.params.data,
  }

  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      // Logging observers must not break MCP transport handling.
    }
  }

  const message = formatLogData(notification.params.data)
  const title = notification.params.logger
    ? `MCP ${notification.params.level}: ${server}/${notification.params.logger}`
    : `MCP ${notification.params.level}: ${server}`

  if (shouldShowNotification(notification.params.level)) {
    addNotification({
      title,
      message,
      kind: notificationKindForLevel(notification.params.level),
      source: 'system',
      channel: 'mcp:logging',
    })
  }

  if (shouldPersistToMcpLog(notification.params.level)) {
    logMCPError(server, `${title}${message ? ` - ${message}` : ''}`)
  }
}

export function __resetMcpLoggingForTests(): void {
  listeners.clear()
}
