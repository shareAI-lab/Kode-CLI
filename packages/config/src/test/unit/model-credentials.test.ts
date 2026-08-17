import { afterEach, describe, expect, test } from 'bun:test'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ModelProfile } from '../../schema'
import {
  clearSessionApiKey,
  getCredentialStorePath,
  getOAuthCredentialBinding,
  getOAuthCredentialId,
  getModelCredentialStatus,
  hasOAuthCredentialBinding,
  readApiKey,
  readApiKeyFromEnvironment,
  storeOAuthCredentialBinding,
  storeApiKey,
} from '../../models/credentials'

const API_KEY_ENV = 'KODE_TEST_PERSISTED_API_KEY'
const originalEnvironmentValue = process.env[API_KEY_ENV]
const originalConfigDirectory = process.env.KODE_CONFIG_DIR
const temporaryDirectories: string[] = []

function useTemporaryCredentialDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'kode-credentials-'))
  temporaryDirectories.push(root)
  process.env.KODE_CONFIG_DIR = root
  return root
}

function makeProfile(): ModelProfile {
  return {
    name: 'Persisted credential test',
    provider: 'custom-openai',
    modelName: 'test-model',
    apiKey: '',
    apiKeyEnv: API_KEY_ENV,
    maxTokens: 1024,
    contextLength: 128_000,
    isActive: true,
    createdAt: 1,
    lastUsed: 1,
  }
}

afterEach(() => {
  clearSessionApiKey(API_KEY_ENV)
  if (originalEnvironmentValue === undefined) delete process.env[API_KEY_ENV]
  else process.env[API_KEY_ENV] = originalEnvironmentValue
  if (originalConfigDirectory === undefined) delete process.env.KODE_CONFIG_DIR
  else process.env.KODE_CONFIG_DIR = originalConfigDirectory
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('model credentials', () => {
  test('stores a direct key under .kode without putting it in the model profile', () => {
    const root = useTemporaryCredentialDirectory()
    const directKey = 'test-persisted-key'
    const profile = makeProfile()
    delete process.env[API_KEY_ENV]

    storeApiKey(API_KEY_ENV, directKey)

    const credentialPath = getCredentialStorePath()
    expect(credentialPath).toBe(join(root, 'credentials.json'))
    expect(readApiKey(API_KEY_ENV)).toBe(directKey)
    expect(getModelCredentialStatus(profile)).toEqual({
      success: true,
      apiKey: directKey,
    })
    expect(profile.apiKey).toBe('')
    expect(process.env[API_KEY_ENV]).toBeUndefined()
    expect(readFileSync(credentialPath, 'utf8')).toContain(directKey)
    if (process.platform !== 'win32') {
      expect(statSync(root).mode & 0o777).toBe(0o700)
      expect(statSync(credentialPath).mode & 0o777).toBe(0o600)
    }
  })

  test('prefers the current session, then the environment, then Kode storage', () => {
    useTemporaryCredentialDirectory()
    delete process.env[API_KEY_ENV]
    storeApiKey(API_KEY_ENV, 'persisted-key')

    expect(readApiKey(API_KEY_ENV)).toBe('persisted-key')
    clearSessionApiKey(API_KEY_ENV)
    process.env[API_KEY_ENV] = 'environment-key'
    expect(readApiKeyFromEnvironment(API_KEY_ENV)).toBe('environment-key')
    expect(readApiKey(API_KEY_ENV)).toBe('environment-key')

    delete process.env[API_KEY_ENV]
    expect(readApiKey(API_KEY_ENV)).toBe('persisted-key')
  })

  test('fails closed instead of overwriting an invalid credential store', () => {
    useTemporaryCredentialDirectory()
    const credentialPath = getCredentialStorePath()
    writeFileSync(credentialPath, '{not valid json}', 'utf8')

    expect(() => storeApiKey(API_KEY_ENV, 'new-key')).toThrow(
      'Kode credential store',
    )
    expect(readFileSync(credentialPath, 'utf8')).toBe('{not valid json}')
  })

  test('persists an OAuth binding without storing a token and resolves it after restart', () => {
    const root = useTemporaryCredentialDirectory()
    const credentialId = storeOAuthCredentialBinding('grok-build', {
      accountLabel: 'grok-user',
      verifiedAt: 123,
    })
    const credentialPath = getCredentialStorePath()
    const persisted = readFileSync(credentialPath, 'utf8')

    expect(credentialId).toBe(getOAuthCredentialId('grok-build'))
    expect(persisted).toContain('oauth:grok-build')
    expect(persisted).toContain('official-runtime')
    expect(persisted).not.toContain('access_token')
    expect(persisted).not.toContain('refresh_token')
    expect(getOAuthCredentialBinding(credentialId)).toEqual({
      provider: 'grok-build',
      credentialStore: 'official-runtime',
      createdAt: 123,
      lastVerifiedAt: 123,
      accountLabel: 'grok-user',
    })

    // Simulate a new Kode process: the disk-backed binding remains readable.
    expect(hasOAuthCredentialBinding(credentialId, 'grok-build')).toBe(true)
    const profile: ModelProfile = {
      name: 'Grok OAuth',
      provider: 'grok-build',
      modelName: 'grok-build:grok-4.6',
      externalModelId: 'grok-4.6',
      oauthCredentialId: credentialId,
      apiKey: '',
      maxTokens: 1024,
      contextLength: 500_000,
      isActive: true,
      createdAt: 1,
    }
    expect(getModelCredentialStatus(profile)).toEqual({
      success: true,
      apiKey: '',
    })
    expect(root).toBeDefined()
  })

  test('fails closed when an OAuth profile has no matching binding', () => {
    useTemporaryCredentialDirectory()
    const profile: ModelProfile = {
      name: 'Missing Grok OAuth',
      provider: 'grok-build',
      modelName: 'grok-build:grok-4.6',
      externalModelId: 'grok-4.6',
      oauthCredentialId: 'oauth:grok-build',
      apiKey: '',
      maxTokens: 1024,
      contextLength: 500_000,
      isActive: true,
      createdAt: 1,
    }

    expect(getModelCredentialStatus(profile)).toMatchObject({
      success: false,
      error: expect.stringContaining('OAuth credential binding is missing'),
    })
  })

  test('refuses a symlinked credential store', () => {
    if (process.platform === 'win32') return

    const root = useTemporaryCredentialDirectory()
    const externalFile = join(root, 'external-credentials.json')
    const credentialPath = getCredentialStorePath()
    writeFileSync(externalFile, 'do not overwrite', 'utf8')
    symlinkSync(externalFile, credentialPath)

    expect(() => storeApiKey(API_KEY_ENV, 'new-key')).toThrow(
      'Kode credential store',
    )
    expect(readFileSync(externalFile, 'utf8')).toBe('do not overwrite')
  })
})
