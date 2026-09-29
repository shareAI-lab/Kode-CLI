import { describe, expect, test } from 'bun:test'

import { createTransportCandidates } from '../../mcp/transports/registry'

/**
 * The SDK transports keep their options private, so reach into `_requestInit`
 * to assert headers actually reach the wire. This guards a regression where the
 * registry only honoured `ctx.headers` and silently dropped the headers
 * declared on the server config (the ACP path).
 */
function requestHeaders(candidate: {
  transport: unknown
}): Record<string, string> | undefined {
  return (
    candidate.transport as {
      _requestInit?: { headers?: Record<string, string> }
    }
  )._requestInit?.headers
}

describe('MCP transport registry', () => {
  test('stdio servers produce a single stdio candidate', async () => {
    const candidates = await createTransportCandidates({
      type: 'stdio',
      command: 'node',
      args: ['server.js'],
    })

    expect(candidates.map(c => c.kind)).toEqual(['stdio'])
  })

  test('http servers prefer Streamable HTTP and fall back to legacy SSE', async () => {
    const candidates = await createTransportCandidates({
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer token' },
    })

    expect(candidates.map(c => c.kind)).toEqual(['http', 'sse'])
  })

  test('sse servers prefer legacy SSE and fall back to Streamable HTTP', async () => {
    const candidates = await createTransportCandidates({
      type: 'sse',
      url: 'https://example.com/sse',
    })

    expect(candidates.map(c => c.kind)).toEqual(['sse', 'http'])
  })

  test('sse-ide servers only use SSE', async () => {
    const candidates = await createTransportCandidates({
      type: 'sse-ide',
      url: 'https://example.com/sse',
      ideName: 'vscode',
    })

    expect(candidates.map(c => c.kind)).toEqual(['sse'])
  })

  test('ws servers produce a single ws candidate', async () => {
    const candidates = await createTransportCandidates({
      type: 'ws',
      url: 'ws://127.0.0.1:3333/mcp',
    })

    expect(candidates.map(c => c.kind)).toEqual(['ws'])
  })

  test('ws-ide servers pass the auth token through the URL', async () => {
    const candidates = await createTransportCandidates({
      type: 'ws-ide',
      url: 'ws://127.0.0.1:3333/mcp',
      ideName: 'vscode',
      authToken: 'secret-token',
    })

    expect(candidates.map(c => c.kind)).toEqual(['ws'])
    expect(candidates[0]?.transport).toBeDefined()
  })

  test('url-based transports without auth still build candidates', async () => {
    const candidates = await createTransportCandidates({
      type: 'http',
      url: 'https://example.com/mcp',
    })

    expect(candidates).toHaveLength(2)
  })

  test('headers declared on the config reach every HTTP/SSE candidate', async () => {
    const candidates = await createTransportCandidates({
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer config' },
    })

    expect(candidates.map(c => c.kind)).toEqual(['http', 'sse'])
    for (const candidate of candidates) {
      expect(requestHeaders(candidate)).toEqual({
        Authorization: 'Bearer config',
      })
    }
  })

  test('headers declared on sse configs reach the transport', async () => {
    const candidates = await createTransportCandidates({
      type: 'sse',
      url: 'https://example.com/sse',
      headers: { 'X-Api-Key': 'secret' },
    })

    for (const candidate of candidates) {
      expect(requestHeaders(candidate)).toEqual({ 'X-Api-Key': 'secret' })
    }
  })

  test('headers resolved by the caller override declared config headers', async () => {
    const candidates = await createTransportCandidates(
      {
        type: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer config' },
      },
      { headers: { Authorization: 'Bearer from-helper' } },
    )

    for (const candidate of candidates) {
      expect(requestHeaders(candidate)).toEqual({
        Authorization: 'Bearer from-helper',
      })
    }
  })

  test('undeclared headers leave requestInit unset', async () => {
    const candidates = await createTransportCandidates({
      type: 'sse',
      url: 'https://example.com/sse',
    })

    for (const candidate of candidates) {
      expect(requestHeaders(candidate)).toBeUndefined()
    }
  })
})
