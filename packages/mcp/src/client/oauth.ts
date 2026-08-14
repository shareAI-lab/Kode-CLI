import * as crypto from 'node:crypto'
import * as http from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  auth,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'

import { PRODUCT_NAME } from '#core/constants/product'
import { openBrowser } from '#core/utils/browser'
import { getKodeRoot as getKodeBaseDir } from '#config/dataRoots'
import { safeParseJSON } from '#core/utils/json'

import { sanitizeMcpIdentifierPart } from './settings'

type StoredMcpOAuthState = {
  redirectPort?: number
  clientInformation?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  pkceCodeVerifier?: string
  expectedState?: string
  lastAuthUrl?: string
  updatedAt?: number
}

export type McpAuthSnapshot = {
  isAuthenticated: boolean
  lastAuthUrl: string | null
}

function getMcpOAuthDir(): string {
  return join(getKodeBaseDir(), 'mcp', 'oauth')
}

function getMcpOAuthFile(serverName: string): string {
  const safe = sanitizeMcpIdentifierPart(serverName)
  return join(getMcpOAuthDir(), `${safe}.json`)
}

function readState(serverName: string): StoredMcpOAuthState {
  const file = getMcpOAuthFile(serverName)
  if (!existsSync(file)) return {}
  const raw = safeParseJSON(readFileSync(file, 'utf8'))
  return raw && typeof raw === 'object' ? (raw as StoredMcpOAuthState) : {}
}

function writeState(serverName: string, next: StoredMcpOAuthState): void {
  const dir = getMcpOAuthDir()
  mkdirSync(dir, { recursive: true })

  const file = getMcpOAuthFile(serverName)
  writeFileSync(file, JSON.stringify(next, null, 2), { encoding: 'utf8' })
}

function stablePortForServer(serverName: string): number {
  const hash = crypto.createHash('sha256').update(serverName).digest()
  const n = hash.readUInt16BE(0)
  return 49152 + (n % 16384)
}

function getOrInitRedirectPort(serverName: string): number {
  const state = readState(serverName)
  const stored = state.redirectPort
  if (
    typeof stored === 'number' &&
    Number.isInteger(stored) &&
    stored >= 1024 &&
    stored <= 65535
  )
    return stored

  const nextPort = stablePortForServer(serverName)
  writeState(serverName, {
    ...state,
    redirectPort: nextPort,
    updatedAt: Date.now(),
  })
  return nextPort
}

class FileBackedMcpOAuthProvider implements OAuthClientProvider {
  readonly serverName: string
  readonly redirectPort: number
  private expectedState: string | null = null
  private onAuthUrl: ((url: string) => void) | null

  constructor(options: {
    serverName: string
    redirectPort: number
    onAuthUrl?: (url: string) => void
  }) {
    this.serverName = options.serverName
    this.redirectPort = options.redirectPort
    this.onAuthUrl = options.onAuthUrl ?? null
  }

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.redirectPort}/callback`
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      client_name: PRODUCT_NAME,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }
  }

  async state(): Promise<string> {
    const state = crypto.randomBytes(16).toString('hex')
    this.expectedState = state
    const stored = readState(this.serverName)
    writeState(this.serverName, {
      ...stored,
      expectedState: state,
      updatedAt: Date.now(),
    })
    return state
  }

  getExpectedState(): string | null {
    return (
      this.expectedState ?? readState(this.serverName).expectedState ?? null
    )
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return readState(this.serverName).clientInformation
  }

  async saveClientInformation(
    clientInformation: OAuthClientInformationMixed,
  ): Promise<void> {
    const stored = readState(this.serverName)
    writeState(this.serverName, {
      ...stored,
      clientInformation,
      updatedAt: Date.now(),
    })
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return readState(this.serverName).tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const stored = readState(this.serverName)
    writeState(this.serverName, { ...stored, tokens, updatedAt: Date.now() })
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const nextUrl = authorizationUrl.toString()
    const stored = readState(this.serverName)
    writeState(this.serverName, {
      ...stored,
      lastAuthUrl: nextUrl,
      updatedAt: Date.now(),
    })
    this.onAuthUrl?.(nextUrl)
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    const stored = readState(this.serverName)
    writeState(this.serverName, {
      ...stored,
      pkceCodeVerifier: codeVerifier,
      updatedAt: Date.now(),
    })
  }

  async codeVerifier(): Promise<string> {
    const verifier = readState(this.serverName).pkceCodeVerifier
    if (!verifier) throw new Error('Missing PKCE code verifier for OAuth flow')
    return verifier
  }

  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier',
  ): Promise<void> {
    const stored = readState(this.serverName)
    const next: StoredMcpOAuthState = { ...stored }

    switch (scope) {
      case 'all': {
        delete next.clientInformation
        delete next.tokens
        delete next.pkceCodeVerifier
        delete next.expectedState
        delete next.lastAuthUrl
        break
      }
      case 'client': {
        delete next.clientInformation
        break
      }
      case 'tokens': {
        delete next.tokens
        break
      }
      case 'verifier': {
        delete next.pkceCodeVerifier
        delete next.expectedState
        break
      }
    }

    next.updatedAt = Date.now()
    writeState(this.serverName, next)
  }
}

export function getMcpOAuthProvider(serverName: string): OAuthClientProvider {
  return new FileBackedMcpOAuthProvider({
    serverName,
    redirectPort: getOrInitRedirectPort(serverName),
  })
}

export function getMcpAuthSnapshot(serverName: string): McpAuthSnapshot {
  const state = readState(serverName)
  const tokens = state.tokens
  return {
    isAuthenticated: Boolean(tokens?.access_token),
    lastAuthUrl: state.lastAuthUrl ?? null,
  }
}

export async function clearMcpAuth(serverName: string): Promise<void> {
  const provider = new FileBackedMcpOAuthProvider({
    serverName,
    redirectPort: getOrInitRedirectPort(serverName),
  })
  await provider.invalidateCredentials('all')
}

export async function authenticateMcpServer(options: {
  serverName: string
  serverUrl: string
  signal?: AbortSignal
  onAuthUrl?: (url: string) => void
}): Promise<{
  authUrl: string | null
  openedBrowser: boolean
}> {
  const desiredPort = getOrInitRedirectPort(options.serverName)
  const serverUrl = new URL(options.serverUrl)

  let server: http.Server | null = null
  let abortCleanup: (() => void) | null = null

  function closeServer(): void {
    abortCleanup?.()
    abortCleanup = null
    try {
      server?.close()
    } catch {
      /* no-op */
    }
    server = null
  }

  let provider: FileBackedMcpOAuthProvider | null = null
  let startedAuthUrl: string | null = null
  let openedBrowser = false

  const authorizationCode = await new Promise<string | null>(
    (resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new Error('Authentication cancelled'))
        return
      }

      const requestHandler: http.RequestListener = (req, res) => {
        try {
          if (!provider) {
            res.writeHead(503)
            res.end('Authentication not ready')
            return
          }

          const url = new URL(req.url || '/', provider.redirectUrl)
          if (url.pathname !== '/callback') {
            res.writeHead(404)
            res.end()
            return
          }

          const code = url.searchParams.get('code')
          const state = url.searchParams.get('state')

          if (!code) {
            res.writeHead(400)
            res.end('Missing authorization code')
            reject(new Error('No authorization code received'))
            closeServer()
            return
          }

          const expected = provider.getExpectedState()
          if (expected && expected !== state) {
            res.writeHead(400)
            res.end('Invalid state parameter')
            reject(new Error('Invalid OAuth state parameter'))
            closeServer()
            return
          }

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(
            '<html><body><p>Authentication complete. You can return to Kode.</p></body></html>',
          )

          resolve(code)
          closeServer()
        } catch (err) {
          res.writeHead(500)
          res.end('Authentication callback failed')
          reject(err instanceof Error ? err : new Error(String(err)))
          closeServer()
        }
      }

      server = http.createServer(requestHandler)

      const start = (port: number): void => {
        server?.listen(port, '127.0.0.1', async () => {
          if (!server) return

          const address = server.address()
          const actualPort =
            address && typeof address === 'object' ? address.port : null
          if (!actualPort) {
            reject(new Error('Failed to start OAuth callback server'))
            closeServer()
            return
          }

          if (actualPort !== desiredPort) {
            const stored = readState(options.serverName)
            writeState(options.serverName, {
              ...stored,
              redirectPort: actualPort,
              clientInformation: undefined,
              tokens: undefined,
              pkceCodeVerifier: undefined,
              expectedState: undefined,
              lastAuthUrl: undefined,
              updatedAt: Date.now(),
            })
          }

          provider = new FileBackedMcpOAuthProvider({
            serverName: options.serverName,
            redirectPort: actualPort,
            onAuthUrl: nextUrl => {
              startedAuthUrl = nextUrl
              options.onAuthUrl?.(nextUrl)
            },
          })

          if (options.signal?.aborted) {
            reject(new Error('Authentication cancelled'))
            closeServer()
            return
          }

          try {
            const result = await auth(provider, { serverUrl })
            if (result === 'AUTHORIZED') {
              resolve(null)
              closeServer()
              return
            }
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)))
            closeServer()
            return
          }

          const authUrl =
            startedAuthUrl ?? readState(options.serverName).lastAuthUrl ?? null
          if (!authUrl) {
            reject(
              new Error('Failed to start OAuth flow: no authorization URL'),
            )
            closeServer()
            return
          }

          openedBrowser = await openBrowser(authUrl)
        })
      }

      server.on('error', err => {
        const maybePortError = err as NodeJS.ErrnoException
        if (maybePortError.code === 'EADDRINUSE') {
          try {
            start(0)
            return
          } catch {
            // fall through
          }
        }

        reject(err)
        closeServer()
      })

      const abortHandler = () => {
        reject(new Error('Authentication cancelled'))
        closeServer()
      }
      options.signal?.addEventListener('abort', abortHandler, { once: true })
      abortCleanup = () =>
        options.signal?.removeEventListener('abort', abortHandler)

      start(desiredPort)
    },
  )

  if (authorizationCode && provider) {
    await auth(provider, { serverUrl, authorizationCode })
  }

  return {
    authUrl:
      startedAuthUrl ?? getMcpAuthSnapshot(options.serverName).lastAuthUrl,
    openedBrowser,
  }
}
