import { afterEach, describe, expect, test } from 'bun:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ElicitationCompleteNotificationSchema,
  ListRootsRequestSchema,
  type ClientCapabilities,
} from '@modelcontextprotocol/sdk/types.js'

import { registerCapabilityHandlers } from '../../mcp/client/capabilities/handlers'
import {
  getMcpClientCapabilities,
  setMcpCapabilityResponders,
  type McpCapabilityResponders,
} from '../../mcp/client/capabilities/responder'

/**
 * Regression guard for a P0: the SDK's `Client.setRequestHandler` throws when a
 * handler is registered for a capability the client did not advertise
 * (`assertRequestHandlerCapability`, client/index.js). Registering all handlers
 * unconditionally while advertising capabilities conditionally made every
 * default host configuration fail to connect at all.
 *
 * These tests therefore use a REAL Client, not a stub: a stub that skips
 * capability validation cannot catch this class of bug.
 */
const PROFILES: Array<{ label: string; responders: McpCapabilityResponders }> =
  [
    {
      label: 'interactive REPL (elicitation, sampling off)',
      responders: {
        elicit: async () => ({ action: 'decline' }),
        elicitationModes: ['form', 'url'],
      },
    },
    { label: 'kode -p / headless (no responders)', responders: {} },
    {
      label: 'elicitation only',
      responders: {
        elicit: async () => ({ action: 'decline' }),
      },
    },
    {
      label: 'sampling only (MCP_ALLOW_SAMPLING=1)',
      responders: {
        sample: async () => ({
          model: 'm',
          role: 'assistant',
          content: { type: 'text', text: '' },
        }),
      },
    },
    {
      label: 'all capabilities',
      responders: {
        elicit: async () => ({ action: 'decline' }),
        elicitationModes: ['form', 'url'],
        sample: async () => ({
          model: 'm',
          role: 'assistant',
          content: { type: 'text', text: '' },
        }),
      },
    },
  ]

function newRealClient(capabilities: ClientCapabilities): Client {
  return new Client(
    { name: 'capability-parity-test', version: '1.0.0' },
    { capabilities },
  )
}

afterEach(() => {
  setMcpCapabilityResponders(null)
})

describe('capability declaration and handler registration stay in sync', () => {
  for (const profile of PROFILES) {
    test(`registers without error: ${profile.label}`, () => {
      setMcpCapabilityResponders(profile.responders)
      const capabilities = getMcpClientCapabilities()
      const client = newRealClient(capabilities)

      expect(() =>
        registerCapabilityHandlers(client, 'srv', { capabilities }),
      ).not.toThrow()
    })
  }

  test('the SDK really does reject an undeclared capability (guard is meaningful)', () => {
    // Proves the guard above is not vacuous: roots-only client + unconditional
    // elicitation/sampling registration is exactly the original bug.
    const capabilities: ClientCapabilities = { roots: { listChanged: false } }

    expect(() =>
      newRealClient(capabilities).setRequestHandler(
        ElicitRequestSchema,
        async () => ({ action: 'decline' as const }),
      ),
    ).toThrow(/elicitation capability/i)

    expect(() =>
      newRealClient(capabilities).setRequestHandler(
        CreateMessageRequestSchema,
        async () => ({
          model: 'm',
          role: 'assistant' as const,
          content: { type: 'text' as const, text: '' },
        }),
      ),
    ).toThrow(/sampling capability/i)
  })

  test('handlers are registered only for advertised capabilities', () => {
    // Recording stub used purely to observe the registration SET.
    const registered = new Map<unknown, unknown>()
    const stub = {
      setRequestHandler: (schema: unknown, handler: unknown) => {
        registered.set(schema, handler)
      },
      setNotificationHandler: (schema: unknown, handler: unknown) => {
        registered.set(schema, handler)
      },
    }

    setMcpCapabilityResponders({})
    const rootsOnly = getMcpClientCapabilities()
    registerCapabilityHandlers(stub as never, 'srv', {
      capabilities: rootsOnly,
    })

    expect(registered.has(ListRootsRequestSchema)).toBe(true)
    expect(registered.has(ElicitRequestSchema)).toBe(false)
    expect(registered.has(CreateMessageRequestSchema)).toBe(false)
    // Notifications need no capability declaration and are always handled.
    expect(registered.has(ElicitationCompleteNotificationSchema)).toBe(true)

    registered.clear()
    setMcpCapabilityResponders({
      elicit: async () => ({ action: 'decline' }),
      sample: async () => ({
        model: 'm',
        role: 'assistant',
        content: { type: 'text', text: '' },
      }),
    })
    const all = getMcpClientCapabilities()
    registerCapabilityHandlers(stub as never, 'srv', { capabilities: all })

    expect(registered.has(ListRootsRequestSchema)).toBe(true)
    expect(registered.has(ElicitRequestSchema)).toBe(true)
    expect(registered.has(CreateMessageRequestSchema)).toBe(true)
  })
})
