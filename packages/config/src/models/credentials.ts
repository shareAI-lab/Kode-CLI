import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { getKodeRoot } from '../dataRoots'
import type { ModelProfile, ProviderType } from '../schema'

const sessionApiKeys = new Map<string, string>()
const CREDENTIAL_STORE_FILE = 'credentials.json'
const CREDENTIAL_STORE_VERSION = 1
const MAX_CREDENTIAL_STORE_BYTES = 1_000_000
const MAX_API_KEY_LENGTH = 64 * 1024
const MAX_OAUTH_CREDENTIALS = 64
const OAUTH_CREDENTIAL_ID_PATTERN = /^oauth:[a-z0-9][a-z0-9-]{0,63}$/

type CredentialStore = {
  version: typeof CREDENTIAL_STORE_VERSION
  apiKeys: Record<string, string>
  oauthCredentials?: Record<string, OAuthCredentialBinding>
}

export type OAuthCredentialProvider =
  'codex-oauth' | 'github-copilot' | 'grok-build'

/**
 * Non-secret Kode-side binding to the credential the official runtime owns.
 * It is deliberately insufficient to authenticate a request on its own.
 */
export type OAuthCredentialBinding = {
  provider: OAuthCredentialProvider
  credentialStore: 'official-runtime'
  createdAt: number
  lastVerifiedAt: number
  accountLabel?: string
}

function normalizeProviderForApiKeyEnvVar(provider: string): string {
  if (provider === 'glm-coding') return 'glm'
  if (provider === 'minimax-coding') return 'minimax'
  return provider
}

export function providerUsesApiKey(provider: ProviderType): boolean {
  return provider !== 'ollama' && !providerUsesOAuthRuntime(provider)
}

export function providerUsesOAuthRuntime(
  provider: ProviderType,
): provider is OAuthCredentialProvider {
  return isOAuthCredentialProvider(provider)
}

export function getApiKeyEnvVarNames(provider: ProviderType): string[] {
  const normalizedProvider = normalizeProviderForApiKeyEnvVar(provider)
  const sanitizedProvider = normalizedProvider.replace(/[^a-z0-9]/gi, '_')
  const canonical = `${sanitizedProvider.toUpperCase()}_API_KEY`
  const legacy = `${normalizedProvider.toUpperCase()}_API_KEY`
  return canonical === legacy ? [canonical] : [canonical, legacy]
}

export function getSuggestedApiKeyEnvVar(
  provider: ProviderType,
): string | undefined {
  if (!providerUsesApiKey(provider)) return undefined
  return getApiKeyEnvVarNames(provider)[0]
}

export function readApiKeyFromEnvironment(
  envVarName: string | undefined,
): string | undefined {
  if (!envVarName) return undefined
  const value = process.env[envVarName]
  return value || undefined
}

/**
 * Returns the owner-only credential file in the user's Kode data directory.
 * A config-directory override is respected so tests and managed installations
 * never write to the user's default Kode directory by accident.
 */
export function getCredentialStorePath(): string {
  return join(getKodeRoot(), CREDENTIAL_STORE_FILE)
}

function emptyCredentialStore(): CredentialStore {
  return {
    version: CREDENTIAL_STORE_VERSION,
    apiKeys: {},
    oauthCredentials: {},
  }
}

function assertCredentialStoreDirectory(directory: string): void {
  if (existsSync(directory)) {
    const stat = lstatSync(directory)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Kode credential directory is not a regular directory')
    }
  } else {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  }

  try {
    chmodSync(directory, 0o700)
  } catch {
    // Windows retains the caller's ACL; POSIX modes are not available there.
  }
}

function parseCredentialStore(content: string): CredentialStore {
  const parsed: unknown = JSON.parse(content)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Kode credential store has an invalid format')
  }

  const store = parsed as Partial<CredentialStore>
  if (
    store.version !== CREDENTIAL_STORE_VERSION ||
    !store.apiKeys ||
    typeof store.apiKeys !== 'object' ||
    Array.isArray(store.apiKeys)
  ) {
    throw new Error('Kode credential store has an unsupported format')
  }

  const apiKeys: Record<string, string> = {}
  for (const [name, value] of Object.entries(store.apiKeys)) {
    if (
      !name ||
      typeof value !== 'string' ||
      !value ||
      value.length > MAX_API_KEY_LENGTH
    ) {
      throw new Error('Kode credential store contains an invalid credential')
    }
    apiKeys[name] = value
  }

  const oauthCredentials: Record<string, OAuthCredentialBinding> = {}
  const rawOAuthCredentials = store.oauthCredentials
  if (rawOAuthCredentials !== undefined) {
    if (
      !rawOAuthCredentials ||
      typeof rawOAuthCredentials !== 'object' ||
      Array.isArray(rawOAuthCredentials) ||
      Object.keys(rawOAuthCredentials).length > MAX_OAUTH_CREDENTIALS
    ) {
      throw new Error('Kode credential store contains invalid OAuth bindings')
    }
    for (const [id, binding] of Object.entries(rawOAuthCredentials)) {
      if (
        !OAUTH_CREDENTIAL_ID_PATTERN.test(id) ||
        !isOAuthCredentialBinding(binding)
      ) {
        throw new Error('Kode credential store contains invalid OAuth bindings')
      }
      oauthCredentials[id] = binding
    }
  }

  return { version: CREDENTIAL_STORE_VERSION, apiKeys, oauthCredentials }
}

function isOAuthCredentialProvider(
  value: unknown,
): value is OAuthCredentialProvider {
  return (
    value === 'codex-oauth' ||
    value === 'github-copilot' ||
    value === 'grok-build'
  )
}

function isOAuthCredentialBinding(
  value: unknown,
): value is OAuthCredentialBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const binding = value as Partial<OAuthCredentialBinding>
  return (
    isOAuthCredentialProvider(binding.provider) &&
    binding.credentialStore === 'official-runtime' &&
    typeof binding.createdAt === 'number' &&
    Number.isFinite(binding.createdAt) &&
    binding.createdAt > 0 &&
    typeof binding.lastVerifiedAt === 'number' &&
    Number.isFinite(binding.lastVerifiedAt) &&
    binding.lastVerifiedAt > 0 &&
    (binding.accountLabel === undefined ||
      (typeof binding.accountLabel === 'string' &&
        binding.accountLabel.length > 0 &&
        binding.accountLabel.length <= 120 &&
        !/[\u0000-\u001f\u007f]/.test(binding.accountLabel)))
  )
}

function readCredentialStore(options?: {
  failOnInvalid?: boolean
}): CredentialStore {
  const path = getCredentialStorePath()
  if (!existsSync(path)) return emptyCredentialStore()

  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error('Kode credential store is not a regular file')
    }
    if (statSync(path).size > MAX_CREDENTIAL_STORE_BYTES) {
      throw new Error('Kode credential store is too large')
    }
    return parseCredentialStore(readFileSync(path, 'utf8'))
  } catch (error) {
    if (options?.failOnInvalid) {
      throw new Error('Kode credential store cannot be read safely', {
        cause: error,
      })
    }
    return emptyCredentialStore()
  }
}

function removeTemporaryCredentialFile(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Cleanup must not hide the original credential persistence error.
  }
}

function writeCredentialStore(store: CredentialStore): void {
  const path = getCredentialStorePath()
  const directory = getKodeRoot()
  assertCredentialStoreDirectory(directory)

  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error('Kode credential store must not be a symbolic link')
  }

  const temporaryPath = `${path}.tmp.${process.pid}.${randomUUID()}`
  const content = `${JSON.stringify(store, null, 2)}\n`

  try {
    writeFileSync(temporaryPath, content, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    try {
      chmodSync(temporaryPath, 0o600)
    } catch {
      // Windows retains the caller's ACL; the restrictive create mode remains
      // the best portable request.
    }
    renameSync(temporaryPath, path)
    try {
      chmodSync(path, 0o600)
    } catch {
      // See the Windows note above.
    }
  } catch (error) {
    removeTemporaryCredentialFile(temporaryPath)
    throw error
  }
}

/**
 * Stores a direct API key in ~/.kode/credentials.json and keeps a process
 * override so an explicitly pasted key wins over an inherited environment
 * variable until this Kode process exits. Model profiles retain only the
 * credential reference, never the key itself.
 */
export function storeApiKey(envVarName: string, apiKey: string): void {
  const normalizedApiKey = apiKey.trim()
  if (
    !envVarName ||
    !normalizedApiKey ||
    normalizedApiKey.length > MAX_API_KEY_LENGTH
  ) {
    throw new Error('API key must be a non-empty supported length')
  }

  const store = readCredentialStore({ failOnInvalid: true })
  store.apiKeys[envVarName] = normalizedApiKey
  writeCredentialStore(store)
  sessionApiKeys.set(envVarName, normalizedApiKey)
}

/** Clears only the current process override; stored credentials remain intact. */
export function clearSessionApiKey(envVarName: string | undefined): void {
  if (envVarName) sessionApiKeys.delete(envVarName)
}

export function hasStoredApiKey(envVarName: string | undefined): boolean {
  if (!envVarName) return false
  return Boolean(
    sessionApiKeys.has(envVarName) || readCredentialStore().apiKeys[envVarName],
  )
}

export function readApiKey(envVarName: string | undefined): string | undefined {
  if (!envVarName) return undefined
  return (
    sessionApiKeys.get(envVarName) ||
    readApiKeyFromEnvironment(envVarName) ||
    readCredentialStore().apiKeys[envVarName]
  )
}

export function getOAuthCredentialId(
  provider: OAuthCredentialProvider,
): string {
  return `oauth:${provider}`
}

/**
 * Persist a non-secret binding after the official runtime has completed OAuth.
 * The provider's access/refresh token never enters this store: it remains in
 * the runtime's OS credential manager or its own protected credential store.
 */
export function storeOAuthCredentialBinding(
  provider: OAuthCredentialProvider,
  options: { accountLabel?: string; verifiedAt?: number } = {},
): string {
  const credentialId = getOAuthCredentialId(provider)
  const now = options.verifiedAt ?? Date.now()
  if (!Number.isFinite(now) || now <= 0) {
    throw new Error('OAuth credential verification time must be valid')
  }
  const accountLabel = options.accountLabel?.trim()
  if (
    accountLabel &&
    (accountLabel.length > 120 || /[\u0000-\u001f\u007f]/.test(accountLabel))
  ) {
    throw new Error('OAuth account label is invalid')
  }

  const store = readCredentialStore({ failOnInvalid: true })
  const oauthCredentials = store.oauthCredentials ?? {}
  if (
    !oauthCredentials[credentialId] &&
    Object.keys(oauthCredentials).length >= MAX_OAUTH_CREDENTIALS
  ) {
    throw new Error('Kode credential store has reached the OAuth binding limit')
  }
  const existing = oauthCredentials[credentialId]
  oauthCredentials[credentialId] = {
    provider,
    credentialStore: 'official-runtime',
    createdAt: existing?.createdAt ?? now,
    lastVerifiedAt: now,
    ...(accountLabel
      ? { accountLabel }
      : existing?.accountLabel
        ? { accountLabel: existing.accountLabel }
        : {}),
  }
  store.oauthCredentials = oauthCredentials
  writeCredentialStore(store)
  return credentialId
}

export function getOAuthCredentialBinding(
  credentialId: string | undefined,
): OAuthCredentialBinding | undefined {
  if (!credentialId || !OAUTH_CREDENTIAL_ID_PATTERN.test(credentialId)) {
    return undefined
  }
  return readCredentialStore().oauthCredentials?.[credentialId]
}

export function hasOAuthCredentialBinding(
  credentialId: string | undefined,
  provider: OAuthCredentialProvider,
): boolean {
  return getOAuthCredentialBinding(credentialId)?.provider === provider
}

export type ModelCredentialStatus =
  { success: true; apiKey: string } | { success: false; error: string }

export function getModelCredentialStatus(
  profile: ModelProfile,
): ModelCredentialStatus {
  if (providerUsesOAuthRuntime(profile.provider)) {
    if (
      hasOAuthCredentialBinding(profile.oauthCredentialId, profile.provider)
    ) {
      return { success: true, apiKey: '' }
    }
    return {
      success: false,
      error:
        `Model '${profile.name}' is blocked because its OAuth credential binding is missing. ` +
        'Run /login and complete the official OAuth flow again.',
    }
  }
  if (!providerUsesApiKey(profile.provider)) {
    return { success: true, apiKey: '' }
  }

  const suggestedEnvVar = getSuggestedApiKeyEnvVar(profile.provider)
  const envVarName = profile.apiKeyEnv

  if (!envVarName) {
    return {
      success: false,
      error:
        `Model '${profile.name}' is blocked for safety because it has no environment-variable credential reference. ` +
        `Configure ${suggestedEnvVar ?? 'a provider API key reference'} and retry. ` +
        'Please rotate any legacy API key previously stored in model configuration.',
    }
  }

  const apiKey = readApiKey(envVarName)
  if (!apiKey) {
    return {
      success: false,
      error:
        `Model '${profile.name}' is blocked for safety because no credential is available for ${envVarName}. ` +
        'Paste a key during model setup or set the environment variable, then retry.',
    }
  }

  return { success: true, apiKey }
}

export function redactModelProfileCredential(
  profile: ModelProfile,
): ModelProfile {
  return { ...profile, apiKey: '' }
}
