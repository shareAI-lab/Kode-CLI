import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getKodeBaseDir } from '#core/utils/env'

import { getMcpAuthSnapshot, getMcpOAuthProvider } from '../../mcp/client/oauth'

const ORIGINAL_CONFIG_DIR = process.env.KODE_CONFIG_DIR

/**
 * Server names are unique per run so a leftover state file can never make the
 * "starts empty" assertion flaky, whichever config root ends up being used.
 * Other suites in this repository rewrite KODE_CONFIG_DIR/HOME, so this file
 * must not rely on being isolated by the environment.
 */
const runId = randomUUID().slice(0, 8)
const serverName = (base: string): string => `${base}-${runId}`

let configDir = ''

/** Path the provider uses for a server, under the *current* config root. */
function stateFilePathFor(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  return join(getKodeBaseDir(), 'mcp', 'oauth', `${safe}.json`)
}

function removeStateFiles(names: string[]): void {
  for (const name of names) {
    try {
      rmSync(stateFilePathFor(name), { force: true })
    } catch {
      // best effort: cleanup must never fail a test
    }
  }
}

const SERVERS = [
  'cache',
  'alpha',
  'beta',
  'rescopable',
  'wipeall',
  'narrow',
  'snapshot',
].map(serverName)

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'kode-oauth-'))
  process.env.KODE_CONFIG_DIR = configDir
})

afterEach(() => {
  // Never leave OAuth state behind, wherever it was written.
  removeStateFiles(SERVERS)

  if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.KODE_CONFIG_DIR
  else process.env.KODE_CONFIG_DIR = ORIGINAL_CONFIG_DIR

  if (configDir) rmSync(configDir, { recursive: true, force: true })
  configDir = ''
})

const discovery = {
  authorizationServerUrl: 'https://auth.example.com',
  resourceMetadataUrl:
    'https://api.example.com/.well-known/oauth-protected-resource',
  authorizationServerMetadata: {
    issuer: 'https://auth.example.com',
    authorization_endpoint: 'https://auth.example.com/authorize',
    token_endpoint: 'https://auth.example.com/token',
    response_types_supported: ['code'],
  },
} as never

describe('MCP OAuth discovery state caching', () => {
  test('caches discovery metadata so reconnects skip discovery', async () => {
    const provider = getMcpOAuthProvider(serverName('cache'))
    expect(await provider.discoveryState?.()).toBeUndefined()

    await provider.saveDiscoveryState?.(discovery)

    // A fresh provider (next CLI start) sees the cached state.
    const reopened = getMcpOAuthProvider(serverName('cache'))
    expect(await reopened.discoveryState?.()).toEqual(discovery)
  })

  test('discovery state is per server', async () => {
    const alpha = getMcpOAuthProvider(serverName('alpha'))
    await alpha.saveDiscoveryState?.(discovery)

    const beta = getMcpOAuthProvider(serverName('beta'))
    expect(await beta.discoveryState?.()).toBeUndefined()
  })

  test("the 'discovery' scope clears cached metadata for re-discovery", async () => {
    const provider = getMcpOAuthProvider(serverName('rescopable'))
    await provider.saveDiscoveryState?.(discovery)
    expect(await provider.discoveryState?.()).toBeDefined()

    await provider.invalidateCredentials?.('discovery')
    expect(await provider.discoveryState?.()).toBeUndefined()
  })

  test("the 'all' scope also clears cached discovery metadata", async () => {
    const provider = getMcpOAuthProvider(serverName('wipeall'))
    await provider.saveDiscoveryState?.(discovery)
    await provider.invalidateCredentials?.('all')
    expect(await provider.discoveryState?.()).toBeUndefined()
  })

  test('narrower scopes leave discovery metadata intact', async () => {
    const provider = getMcpOAuthProvider(serverName('narrow'))
    await provider.saveDiscoveryState?.(discovery)

    await provider.invalidateCredentials?.('tokens')
    expect(await provider.discoveryState?.()).toEqual(discovery)

    await provider.invalidateCredentials?.('verifier')
    expect(await provider.discoveryState?.()).toEqual(discovery)
  })

  test('auth snapshot is unaffected by discovery caching', async () => {
    const provider = getMcpOAuthProvider(serverName('snapshot'))
    await provider.saveDiscoveryState?.(discovery)

    expect(getMcpAuthSnapshot(serverName('snapshot'))).toEqual({
      isAuthenticated: false,
      lastAuthUrl: null,
    })
  })
})
