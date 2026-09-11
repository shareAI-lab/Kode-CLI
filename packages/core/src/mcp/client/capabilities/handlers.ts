import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ElicitationCompleteNotificationSchema,
  type ClientCapabilities,
  ListRootsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

import { logMCPError } from '#core/utils/log'

import type { McpRoot } from './roots'
import {
  getMcpCapabilityResponders,
  getMcpClientCapabilities,
  resolveMcpRoots,
} from './responder'

export type RegisterCapabilityHandlersOptions = {
  /**
   * The exact capabilities the client advertised to the server.
   *
   * The SDK throws when a handler is registered for a capability the client did
   * not declare, so handlers must be gated on this — pass the very same object
   * given to the `Client` constructor. Defaults to
   * {@link getMcpClientCapabilities}.
   */
  capabilities?: ClientCapabilities
  /**
   * Per-client roots override. Hosts whose workspace is scoped per session
   * (the ACP agent uses the client-provided session cwd) install their roots
   * here instead of relying on the process-wide config.
   */
  getRoots?: (serverName: string) => Promise<McpRoot[]>
}

/**
 * Register the server-to-client handlers Kode can actually serve.
 *
 * Registration is gated on the advertised capabilities because the SDK rejects
 * a handler whose capability was not declared. That keeps the pair in sync by
 * construction: a capability that is not advertised is answered by the SDK with
 * a JSON-RPC "method not found", which is the fail-closed behaviour hosts rely
 * on. Handlers that *are* registered still fail closed internally (declining or
 * cancelling) for requests they cannot fulfil.
 */
export function registerCapabilityHandlers(
  client: Client,
  serverName: string,
  options: RegisterCapabilityHandlersOptions = {},
): void {
  const capabilities = options.capabilities ?? getMcpClientCapabilities()

  if (capabilities.roots) {
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: options.getRoots
        ? await options.getRoots(serverName)
        : await resolveMcpRoots(serverName),
    }))
  }

  if (capabilities.elicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
      const { elicit } = getMcpCapabilityResponders()
      if (!elicit) return { action: 'decline' as const }

      try {
        return await elicit(serverName, request, { signal: extra?.signal })
      } catch (error) {
        logMCPError(
          serverName,
          `Elicitation failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
        return { action: 'cancel' as const }
      }
    })
  }

  if (capabilities.sampling) {
    client.setRequestHandler(
      CreateMessageRequestSchema,
      async (request, extra) => {
        const { sample } = getMcpCapabilityResponders()
        if (!sample) {
          throw new Error(
            `MCP server "${serverName}" requested sampling, but no sampler is installed`,
          )
        }
        return await sample(serverName, request, { signal: extra?.signal })
      },
    )
  }

  // URL-mode elicitation is resolved out of band: the user finishes in a
  // browser and the server tells us it is done. There is nothing to prompt
  // for, so this is recorded for observability only. Notifications need no
  // capability declaration.
  client.setNotificationHandler(
    ElicitationCompleteNotificationSchema,
    notification => {
      logMCPError(
        serverName,
        `Elicitation ${notification.params.elicitationId} completed`,
      )
    },
  )
}
