import { afterEach, describe, expect, test } from 'bun:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  ElicitRequestSchema,
  ElicitResultSchema,
  ListRootsRequestSchema,
  ListRootsResultSchema,
} from '@modelcontextprotocol/sdk/types.js'

import {
  getMcpClientCapabilities,
  registerCapabilityHandlers,
  setMcpCapabilityResponders,
  type McpCapabilityResponders,
  type McpRoot,
} from '../../mcp/client/capabilities'

/**
 * End-to-end capability round-trips over a real `Server` and the SDK's in-memory
 * transport.
 *
 * This class of bug (declaring capabilities that do not match the registered
 * handlers) is invisible to stub-based tests, because only the real SDK client
 * validates the pairing. These tests exercise the real client factory, real
 * handlers and a real server.
 */
async function connectPair(options: {
  responders: McpCapabilityResponders
  getRoots?: (serverName: string) => Promise<McpRoot[]>
}): Promise<{ client: Client; server: Server }> {
  setMcpCapabilityResponders(options.responders)

  const server = new Server(
    { name: 'fixture-server', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)

  const capabilities = getMcpClientCapabilities()
  const client = new Client(
    { name: 'roundtrip-client', version: '1.0.0' },
    { capabilities },
  )
  // The exact production pairing: one capabilities object for both.
  registerCapabilityHandlers(client, 'fixture', {
    capabilities,
    getRoots: options.getRoots,
  })
  await client.connect(clientTransport)

  return { client, server }
}

const open: Array<() => Promise<void>> = []

afterEach(async () => {
  while (open.length > 0) {
    try {
      await open.pop()?.()
    } catch {
      // best effort
    }
  }
  setMcpCapabilityResponders(null)
})

describe('MCP capability round-trip (real client + real server)', () => {
  test('a default (roots-only) client initializes against a real server', async () => {
    const { client, server } = await connectPair({ responders: {} })
    open.push(async () => {
      await client.close()
      await server.close()
    })

    // Initialization succeeded — this is what previously threw for every host.
    expect(client.getServerVersion()).toMatchObject({ name: 'fixture-server' })
    expect(client.getServerCapabilities()).toBeDefined()
  })

  test('roots/list is served end-to-end from the installed roots provider', async () => {
    const served: string[] = []
    const { client, server } = await connectPair({
      responders: {},
      getRoots: async () => {
        served.push('called')
        return [{ uri: 'file:///workspace/project', name: 'project' }]
      },
    })
    open.push(async () => {
      await client.close()
      await server.close()
    })

    const result = await server.request(
      { method: 'roots/list' },
      ListRootsResultSchema,
    )

    expect(served).toEqual(['called'])
    expect(result.roots).toEqual([
      { uri: 'file:///workspace/project', name: 'project' },
    ])
    // The server saw the client advertise roots.
    expect(server.getClientCapabilities()?.roots).toBeDefined()
  })

  test('elicitation round-trips when the capability is declared', async () => {
    const { client, server } = await connectPair({
      responders: {
        elicit: async (serverName, request) => {
          expect(serverName).toBe('fixture')
          return {
            action: 'accept',
            content: { answer: request.params.message },
          }
        },
        elicitationModes: ['form', 'url'],
      },
    })
    open.push(async () => {
      await client.close()
      await server.close()
    })

    expect(server.getClientCapabilities()?.elicitation).toBeDefined()

    const result = await server.request(
      {
        method: 'elicitation/create',
        params: {
          message: 'Which repo?',
          requestedSchema: {
            type: 'object',
            properties: {},
          },
        },
      },
      ElicitResultSchema,
    )

    expect(result).toMatchObject({
      action: 'accept',
      content: { answer: 'Which repo?' },
    })
  })

  test('elicitation fails closed with method-not-found when not declared', async () => {
    const { client, server } = await connectPair({ responders: {} })
    open.push(async () => {
      await client.close()
      await server.close()
    })

    // Not advertised ...
    expect(server.getClientCapabilities()?.elicitation).toBeUndefined()

    // ... so a server request is rejected rather than silently hanging. This is
    // the fail-closed contract the docs claim.
    await expect(
      server.request(
        {
          method: 'elicitation/create',
          params: {
            message: 'nope',
            requestedSchema: {
              type: 'object',
              properties: {},
            },
          },
        },
        ElicitRequestSchema,
      ),
    ).rejects.toThrow(/method not found|not supported|-32601/i)
  })
})
