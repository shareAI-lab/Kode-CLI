import { afterEach, describe, expect, test } from 'bun:test'
import { pathToFileURL } from 'node:url'

import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ElicitationCompleteNotificationSchema,
  ListRootsRequestSchema,
  type ClientCapabilities,
  type CreateMessageResult,
} from '@modelcontextprotocol/sdk/types.js'

import { registerCapabilityHandlers } from '../../mcp/client/capabilities/handlers'
import {
  getMcpClientCapabilities,
  setMcpCapabilityResponders,
} from '../../mcp/client/capabilities/responder'
import {
  buildMcpRoots,
  getDefaultMcpRoots,
} from '../../mcp/client/capabilities/roots'

type Handler = (request: unknown, extra?: unknown) => unknown

const notifications = new Map<unknown, Handler>()

type CaptureOptions = {
  getRoots?: (serverName: string) => Promise<{ uri: string; name?: string }[]>
  capabilities?: ClientCapabilities
}

/**
 * Records the registration SET. Capabilities default to the live host
 * capabilities, matching production, so a handler is only captured when its
 * capability is actually advertised.
 */
function captureHandlers(options: CaptureOptions = {}): Map<unknown, Handler> {
  const handlers = new Map<unknown, Handler>()
  const fakeClient = {
    setRequestHandler: (schema: unknown, handler: Handler) => {
      handlers.set(schema, handler)
    },
    setNotificationHandler: (schema: unknown, handler: Handler) => {
      notifications.set(schema, handler)
    },
  }
  notifications.clear()
  registerCapabilityHandlers(fakeClient as never, 'srv', options)
  return handlers
}

describe('MCP client capability advertisement', () => {
  afterEach(() => {
    setMcpCapabilityResponders(null)
  })

  test('roots are always advertised; elicitation/sampling are not by default', () => {
    setMcpCapabilityResponders(null)

    const capabilities = getMcpClientCapabilities()
    expect(capabilities.roots).toBeDefined()
    expect(capabilities.elicitation).toBeUndefined()
    expect(capabilities.sampling).toBeUndefined()
  })

  test('elicitation is advertised only when a responder is installed', () => {
    setMcpCapabilityResponders({
      elicit: async () => ({ action: 'decline' }),
    })
    expect(getMcpClientCapabilities().elicitation).toEqual({ form: {} })

    setMcpCapabilityResponders({
      elicit: async () => ({ action: 'decline' }),
      elicitationModes: ['form', 'url'],
    })
    expect(getMcpClientCapabilities().elicitation).toEqual({
      form: {},
      url: {},
    })
  })

  test('sampling is advertised only when a sampler is installed', () => {
    setMcpCapabilityResponders({
      sample: async (): Promise<CreateMessageResult> => ({
        model: 'test',
        role: 'assistant',
        content: { type: 'text', text: 'ok' },
      }),
    })
    expect(getMcpClientCapabilities().sampling).toEqual({})
  })
})

describe('MCP roots protocol', () => {
  test('fails closed before workspace trust is accepted', () => {
    expect(
      buildMcpRoots({
        trusted: false,
        configured: ['/tmp/alpha'],
        cwd: '/tmp/alpha',
      }),
    ).toEqual([])
  })

  test('exposes the working directory once trusted', () => {
    const roots = buildMcpRoots({
      trusted: true,
      configured: [],
      cwd: '/tmp/workspace',
    })

    // Compute the expectation through the same platform-aware helper: on
    // Windows a POSIX path resolves to a drive-qualified file URL.
    expect(roots).toEqual([
      { uri: pathToFileURL('/tmp/workspace').toString(), name: 'workspace' },
    ])
  })

  test('configured roots take precedence and duplicates collapse', () => {
    const roots = buildMcpRoots({
      trusted: true,
      configured: ['/tmp/alpha', '/tmp/alpha', '/tmp/beta'],
      cwd: '/tmp/workspace',
    })

    expect(roots.map(root => root.uri)).toEqual([
      pathToFileURL('/tmp/alpha').toString(),
      pathToFileURL('/tmp/beta').toString(),
    ])
  })

  test('blank configured entries are ignored', () => {
    const roots = buildMcpRoots({
      trusted: true,
      configured: ['   ', ''],
      cwd: '/tmp/workspace',
    })

    expect(roots).toEqual([])
  })

  test('the live accessor stays fail-closed in an untrusted test process', () => {
    expect(getDefaultMcpRoots()).toEqual([])
  })

  test('the roots/list handler returns an array of roots', async () => {
    const handlers = captureHandlers()
    const handler = handlers.get(ListRootsRequestSchema)
    expect(handler).toBeDefined()

    const result = (await handler!({ method: 'roots/list' })) as {
      roots: unknown[]
    }
    expect(Array.isArray(result.roots)).toBe(true)
  })

  test('a per-client roots override wins over process-wide config', async () => {
    // This is how the ACP agent serves roots from the session cwd.
    const handlers = captureHandlers({
      getRoots: async () => [
        { uri: 'file:///workspace/session', name: 'session' },
      ],
    })

    const handler = handlers.get(ListRootsRequestSchema)
    const result = await handler!({ method: 'roots/list' })

    expect(result).toEqual({
      roots: [{ uri: 'file:///workspace/session', name: 'session' }],
    })
  })

  test('the elicitation-complete notification is handled, not dropped', () => {
    captureHandlers()

    const handler = notifications.get(ElicitationCompleteNotificationSchema)
    expect(handler).toBeDefined()

    // URL-mode completions are informational; handling them must not throw.
    expect(() =>
      handler!({
        method: 'notifications/elicitation/complete',
        params: { elicitationId: 'elicit-1' },
      }),
    ).not.toThrow()
  })
})

describe('MCP capability handlers are gated on declared capabilities', () => {
  afterEach(() => setMcpCapabilityResponders(null))

  test('no responder means no handler: the SDK answers method-not-found', () => {
    // Fail-closed is now enforced by *not registering* the handler, because the
    // capability is not advertised either. Registering it anyway throws in the
    // real SDK, which is what previously broke every connection.
    setMcpCapabilityResponders(null)
    const handlers = captureHandlers()

    expect(handlers.has(ElicitRequestSchema)).toBe(false)
    expect(handlers.has(CreateMessageRequestSchema)).toBe(false)
    // roots is always advertised, so its handler is always present.
    expect(handlers.has(ListRootsRequestSchema)).toBe(true)
  })

  test('an installed responder enables and serves elicitation', async () => {
    setMcpCapabilityResponders({
      elicit: async (serverName, request) => ({
        action: 'accept',
        content: { server: serverName, message: request.params.message },
      }),
    })
    const handler = captureHandlers().get(ElicitRequestSchema)
    expect(handler).toBeDefined()

    const result = await handler!({
      method: 'elicitation/create',
      params: { message: 'Pick one' },
    })
    expect(result).toEqual({
      action: 'accept',
      content: { server: 'srv', message: 'Pick one' },
    })
  })

  test('a throwing elicitation responder cancels instead of crashing', async () => {
    setMcpCapabilityResponders({
      elicit: async () => {
        throw new Error('ui exploded')
      },
    })
    const handler = captureHandlers().get(ElicitRequestSchema)

    const result = await handler!({
      method: 'elicitation/create',
      params: { message: 'Pick one' },
    })
    expect(result).toEqual({ action: 'cancel' })
  })

  test('an installed sampler enables and serves sampling', async () => {
    setMcpCapabilityResponders({
      sample: async () => ({
        model: 'test-model',
        role: 'assistant',
        content: { type: 'text', text: 'hello' },
      }),
    })
    const handler = captureHandlers().get(CreateMessageRequestSchema)
    expect(handler).toBeDefined()

    const result = await handler!({
      method: 'sampling/createMessage',
      params: { messages: [], maxTokens: 16 },
    })
    expect(result).toMatchObject({ model: 'test-model' })
  })

  test('a declared capability with no responder still fails closed', async () => {
    // Defensive: a host may declare sampling via explicit capabilities without
    // installing a sampler (e.g. a future host). The handler must reject rather
    // than silently returning an empty completion.
    setMcpCapabilityResponders(null)
    const handler = captureHandlers({
      capabilities: { roots: { listChanged: false }, sampling: {} },
    }).get(CreateMessageRequestSchema)

    expect(handler).toBeDefined()
    await expect(
      handler!({
        method: 'sampling/createMessage',
        params: { messages: [], maxTokens: 16 },
      }),
    ).rejects.toThrow('no sampler is installed')
  })
})
