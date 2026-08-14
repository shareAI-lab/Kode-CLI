import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { ServerCapabilities } from '@modelcontextprotocol/sdk/types.js'

export type ConnectedClient = {
  client: Client
  capabilities?: ServerCapabilities | null
  name: string
  type: 'connected'
}

export type FailedClient = {
  name: string
  type: 'failed'
}

export type NeedsAuthClient = {
  name: string
  type: 'needs-auth'
}

export type WrappedClient = ConnectedClient | FailedClient | NeedsAuthClient
