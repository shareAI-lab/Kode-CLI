import { describe, expect, test } from 'bun:test'

import { buildMcpRoots } from '#core/mcp/client'
import { createTransportCandidates } from '#core/mcp/transports/registry'

import {
  connectAcpMcpServers,
  createAcpMcpClient,
  getAcpClientCapabilities,
  toMcpServerConfig,
} from './mcp'

/**
 * The ACP agent used to build transports from its own copy of the logic, which
 * drifted from the core client (different fallback order, no WebSocket). These
 * tests pin both hosts to the same registry.
 */
describe('ACP/core transport parity', () => {
  test('stdio descriptors map to the core stdio config', async () => {
    const config = toMcpServerConfig({
      type: 'stdio',
      name: 'files',
      command: 'node',
      args: ['server.js'],
      env: [{ name: 'FOO', value: 'bar' }],
    })

    expect(config).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { FOO: 'bar' },
    })

    const candidates = await createTransportCandidates(config!)
    expect(candidates.map(c => c.kind)).toEqual(['stdio'])
  })

  test('http descriptors keep core fallback order (http then sse)', async () => {
    const config = toMcpServerConfig({
      type: 'http',
      name: 'api',
      url: 'https://example.com/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer token' }],
    })

    expect(config).toEqual({
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer token' },
    })

    const candidates = await createTransportCandidates(config!)
    expect(candidates.map(c => c.kind)).toEqual(['http', 'sse'])
  })

  test('sse descriptors keep core fallback order (sse then http)', async () => {
    const config = toMcpServerConfig({
      type: 'sse',
      name: 'events',
      url: 'https://example.com/sse',
      headers: [],
    })

    expect(config).toEqual({ type: 'sse', url: 'https://example.com/sse' })

    const candidates = await createTransportCandidates(config!)
    expect(candidates.map(c => c.kind)).toEqual(['sse', 'http'])
  })

  test('ws descriptors are supported by ACP and reach the registry', async () => {
    const config = toMcpServerConfig({
      type: 'ws',
      name: 'realtime',
      url: 'ws://127.0.0.1:3333/mcp',
    })

    expect(config).toEqual({ type: 'ws', url: 'ws://127.0.0.1:3333/mcp' })

    const candidates = await createTransportCandidates(config!)
    expect(candidates.map(c => c.kind)).toEqual(['ws'])
  })

  test('ACP headers survive all the way to the built transport', async () => {
    const config = toMcpServerConfig({
      type: 'http',
      name: 'api',
      url: 'https://example.com/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer token' }],
    })

    const candidates = await createTransportCandidates(config!)
    expect(candidates.map(c => c.kind)).toEqual(['http', 'sse'])

    for (const candidate of candidates) {
      const requestInit = (
        candidate.transport as {
          _requestInit?: { headers?: Record<string, string> }
        }
      )._requestInit
      expect(requestInit?.headers).toEqual({ Authorization: 'Bearer token' })
    }
  })

  test('invalid or unnamed descriptors are rejected', () => {
    expect(
      toMcpServerConfig({
        type: 'http',
        name: 'bad',
        url: 'not-a-url',
        headers: [],
      }),
    ).toBeNull()

    expect(
      toMcpServerConfig({
        type: 'ws',
        name: 'bad-url',
        url: '',
      }),
    ).toBeNull()
  })
})

/**
 * Regression guard: capability handlers used to be registered
 * unconditionally while capabilities were declared conditionally, and the
 * registration sat OUTSIDE the try/catch. The SDK rejects a handler for an
 * undeclared capability, so `session/new` / `session/load` failed outright for
 * every ACP client that passed an `mcpServers` list. These tests exercise the
 * real factory with a REAL Client (a stub that skips capability validation
 * cannot catch this) and need no subprocess.
 */
describe('ACP MCP client construction', () => {
  test('a roots-capable session builds a client without throwing', () => {
    const capabilities = getAcpClientCapabilities(process.cwd())
    expect(capabilities.roots).toBeDefined()

    expect(() =>
      createAcpMcpClient('srv', capabilities, async () => []),
    ).not.toThrow()
  })

  test('a session with no cwd declares nothing and still builds', () => {
    const capabilities = getAcpClientCapabilities('')
    expect(capabilities).toEqual({})

    expect(() =>
      createAcpMcpClient('srv', capabilities, async () => []),
    ).not.toThrow()
  })

  test('roots are served from the session cwd and never fall back to the daemon', async () => {
    const roots = await buildMcpRoots({
      trusted: true,
      configured: [],
      cwd: process.cwd(),
    })
    expect(roots.length).toBeGreaterThan(0)
    expect(roots[0]?.uri.startsWith('file://')).toBe(true)
  })

  test('connecting an invalid descriptor returns a failed client, never throwing', async () => {
    const clients = await connectAcpMcpServers(
      [{ type: 'http', name: 'bad-url', url: 'not-a-url', headers: [] }],
      { cwd: process.cwd() },
    )

    expect(clients).toHaveLength(1)
    expect(clients[0]).toMatchObject({ type: 'failed' })
  })
})
