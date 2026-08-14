import {
  ListResourceTemplatesResultSchema,
  ListResourcesResultSchema,
  type ListResourceTemplatesResult,
  type ListResourcesResult,
  type Resource,
  type ResourceTemplate,
} from '@modelcontextprotocol/sdk/types.js'
import { memoize } from 'lodash-es'

import { getMcpListChangedVersion } from './listChanged'
import { requestAllPages } from './request'
import { getClients } from './clients'
import type { ConnectedClient, WrappedClient } from './types'

export type McpResource = Resource & {
  server: string
}

export type McpResourceTemplate = ResourceTemplate & {
  server: string
}

function getCapabilities(client: ConnectedClient) {
  if (client.capabilities) return client.capabilities
  try {
    return client.client.getServerCapabilities() ?? null
  } catch {
    return null
  }
}

async function findResourceSubscriptionClient(
  server: string,
): Promise<ConnectedClient> {
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
  if (!capabilities?.resources) {
    throw new Error(`Server "${server}" does not support resources`)
  }
  if (!capabilities.resources.subscribe) {
    throw new Error(
      `Server "${server}" does not support resource subscriptions`,
    )
  }

  return match
}

export async function subscribeMCPResource({
  server,
  uri,
}: {
  server: string
  uri: string
}): Promise<void> {
  const match = await findResourceSubscriptionClient(server)
  await match.client.subscribeResource({ uri })
}

export async function unsubscribeMCPResource({
  server,
  uri,
}: {
  server: string
  uri: string
}): Promise<void> {
  const match = await findResourceSubscriptionClient(server)
  await match.client.unsubscribeResource({ uri })
}

export const getMCPResources = memoize(
  async (): Promise<McpResource[]> => {
    const resourceList = await requestAllPages<
      ListResourcesResult,
      typeof ListResourcesResultSchema
    >({ method: 'resources/list' }, ListResourcesResultSchema, 'resources')

    return resourceList.flatMap(({ client, results }) =>
      results.flatMap(result =>
        (result.resources ?? []).map(resource => ({
          ...resource,
          server: client.name,
        })),
      ),
    )
  },
  () => `resources@${getMcpListChangedVersion('resources')}`,
)

export const getMCPResourceTemplates = memoize(
  async (): Promise<McpResourceTemplate[]> => {
    const templateList = await requestAllPages<
      ListResourceTemplatesResult,
      typeof ListResourceTemplatesResultSchema
    >(
      { method: 'resources/templates/list' },
      ListResourceTemplatesResultSchema,
      'resources',
    )

    return templateList.flatMap(({ client, results }) =>
      results.flatMap(result =>
        (result.resourceTemplates ?? []).map(template => ({
          ...template,
          server: client.name,
        })),
      ),
    )
  },
  () => `resource-templates@${getMcpListChangedVersion('resources')}`,
)
