import type {
  CompleteRequest,
  CompleteResult,
} from '@modelcontextprotocol/sdk/types.js'

import { getClients } from './clients'
import type { ConnectedClient, WrappedClient } from './types'

export type McpCompletionRef =
  { type: 'ref/prompt'; name: string } | { type: 'ref/resource'; uri: string }

export type McpCompletionRequest = {
  server: string
  ref: McpCompletionRef
  argument: {
    name: string
    value: string
  }
  context?: {
    arguments?: Record<string, string>
  }
}

export type McpCompletion = CompleteResult['completion']

function getCapabilities(client: ConnectedClient) {
  if (client.capabilities) return client.capabilities
  try {
    return client.client.getServerCapabilities() ?? null
  } catch {
    return null
  }
}

async function findCompletionClient(server: string): Promise<ConnectedClient> {
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
  if (!capabilities?.completions) {
    throw new Error(`Server "${server}" does not support completions`)
  }

  return match
}

export async function completeMCPArgument({
  server,
  ref,
  argument,
  context,
}: McpCompletionRequest): Promise<McpCompletion> {
  const match = await findCompletionClient(server)
  const params: CompleteRequest['params'] = {
    ref,
    argument,
    ...(context ? { context } : {}),
  }
  const result = await match.client.complete(params)
  return result.completion
}
