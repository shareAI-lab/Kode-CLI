import {
  isSupportedPermissionModeInput,
  normalizePermissionMode,
  type PermissionMode,
} from '#core/types/PermissionMode'
import type { WrappedClient } from '#core/mcp/client'
import type { ControlRequestMessage } from '#protocol/structuredStdio'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function getClientTransport(
  client: unknown,
): { onmessage?: (message: unknown) => void } | null {
  if (!isRecord(client)) return null
  const transport = client.transport
  if (!isRecord(transport)) return null
  return transport as { onmessage?: (message: unknown) => void }
}

export function createPrintControlRequestHandler(args: {
  mcpClients: WrappedClient[]
  setPermissionMode: (mode: PermissionMode) => void
  setModel: (model: string | undefined) => void
  setMaxThinkingTokens: (tokens: number) => void
}): (msg: ControlRequestMessage) => Promise<unknown | void> {
  return async msg => {
    const subtype = msg.request?.subtype

    if (subtype === 'initialize') return undefined

    if (subtype === 'set_permission_mode') {
      const mode = msg.request.mode
      if (isSupportedPermissionModeInput(mode)) {
        args.setPermissionMode(normalizePermissionMode(mode))
      }
      return undefined
    }

    if (subtype === 'set_model') {
      const requested = msg.request.model
      if (requested === 'default') {
        args.setModel(undefined)
      } else if (typeof requested === 'string' && requested.trim()) {
        args.setModel(requested.trim())
      }
      return undefined
    }

    if (subtype === 'set_max_thinking_tokens') {
      const value = msg.request.max_thinking_tokens
      if (value === null) {
        args.setMaxThinkingTokens(0)
      } else if (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= 0
      ) {
        args.setMaxThinkingTokens(value)
      }
      return undefined
    }

    if (subtype === 'mcp_status') {
      return {
        mcpServers: args.mcpClients.map(c => ({
          name: c.name,
          status: c.type,
          ...(c.type === 'connected' && c.capabilities
            ? { serverInfo: c.capabilities }
            : {}),
        })),
      }
    }

    if (subtype === 'mcp_message') {
      const serverName = msg.request.server_name
      const message = msg.request.message
      if (typeof serverName === 'string' && serverName) {
        const found = args.mcpClients.find(c => c.name === serverName)
        if (found && found.type === 'connected') {
          const transport = getClientTransport(found.client)
          if (transport && typeof transport.onmessage === 'function') {
            transport.onmessage(message)
          }
        }
      }
      return undefined
    }

    if (subtype === 'mcp_set_servers') {
      return { ok: true, sdkServersChanged: false }
    }

    if (subtype === 'rewind_files') {
      throw new Error('rewind_files is not supported in Kode yet.')
    }

    throw new Error(`Unsupported control request subtype: ${String(subtype)}`)
  }
}
