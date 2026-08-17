import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_VOICE_CONFIG,
  getVoiceCredentialStatus,
  redactVoiceConfig,
  resolveVoiceConfig,
  storeVoiceApiKey,
} from '../../voice'
import {
  EXPERIMENTAL_MCP_SAMPLING_ENV,
  EXPERIMENTAL_VOICE_ENV,
  isExperimentalMcpSamplingEnabled,
  isExperimentalVoiceEnabled,
} from '../../experimental'
import {
  clearSessionApiKey,
  getCredentialStorePath,
} from '../../models/credentials'

const VOICE_API_KEY_ENV = 'KODE_VOICE_TEST_API_KEY'
const originalConfigDirectory = process.env.KODE_CONFIG_DIR
const originalApiKey = process.env[VOICE_API_KEY_ENV]
const temporaryDirectories: string[] = []

afterEach(() => {
  clearSessionApiKey(VOICE_API_KEY_ENV)
  if (originalConfigDirectory === undefined) delete process.env.KODE_CONFIG_DIR
  else process.env.KODE_CONFIG_DIR = originalConfigDirectory
  if (originalApiKey === undefined) delete process.env[VOICE_API_KEY_ENV]
  else process.env[VOICE_API_KEY_ENV] = originalApiKey
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('voice configuration', () => {
  test('keeps voice enabled by default with an explicit opt-out', () => {
    expect(isExperimentalVoiceEnabled({})).toBe(true)
    expect(isExperimentalVoiceEnabled({ [EXPERIMENTAL_VOICE_ENV]: '1' })).toBe(
      true,
    )
    expect(
      isExperimentalVoiceEnabled({ [EXPERIMENTAL_VOICE_ENV]: 'false' }),
    ).toBe(false)
    expect(isExperimentalVoiceEnabled({ [EXPERIMENTAL_VOICE_ENV]: '0' })).toBe(
      false,
    )
  })

  test('keeps MCP sampling disabled unless its own flag is explicit', () => {
    expect(isExperimentalMcpSamplingEnabled({})).toBe(false)
    expect(
      isExperimentalMcpSamplingEnabled({
        [EXPERIMENTAL_MCP_SAMPLING_ENV]: 'enabled',
      }),
    ).toBe(true)
  })

  test('uses built-in MiMo defaults without storing a credential', () => {
    const resolved = resolveVoiceConfig(undefined)
    expect(resolved).toEqual({ ok: true, config: DEFAULT_VOICE_CONFIG })
  })

  test('fails closed for unsafe endpoints and malformed settings', () => {
    expect(
      resolveVoiceConfig({ baseURL: 'http://api.example.test/v1' }),
    ).toEqual({
      ok: false,
      message:
        'voice.baseURL must use HTTPS (except a loopback development proxy).',
    })
    expect(resolveVoiceConfig({ apiKeyEnv: 'MIMO-KEY' })).toEqual({
      ok: false,
      message: 'voice.apiKeyEnv must be a valid environment variable name.',
    })
    expect(resolveVoiceConfig({ maxRecordingSeconds: 181 })).toEqual({
      ok: false,
      message: 'voice.maxRecordingSeconds must be an integer from 1 to 180.',
    })
  })

  test('allows an explicit loopback development proxy and normalizes values', () => {
    const resolved = resolveVoiceConfig({
      baseURL: 'http://127.0.0.1:4000/v1/',
      apiKeyEnv: ' TEST_MIMO_KEY ',
      language: 'zh',
      speakResponses: false,
    })
    expect(resolved).toEqual({
      ok: true,
      config: {
        ...DEFAULT_VOICE_CONFIG,
        baseURL: 'http://127.0.0.1:4000/v1',
        apiKeyEnv: 'TEST_MIMO_KEY',
        language: 'zh',
        speakResponses: false,
      },
    })
  })

  test('persists a pasted MiMo key only in the owner-only credential store', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kode-voice-credential-'))
    temporaryDirectories.push(directory)
    process.env.KODE_CONFIG_DIR = directory
    delete process.env[VOICE_API_KEY_ENV]

    const resolved = resolveVoiceConfig({ apiKeyEnv: VOICE_API_KEY_ENV })
    if (!resolved.ok) throw new Error(resolved.message)
    storeVoiceApiKey(resolved.config, 'voice-test-key')

    expect(getVoiceCredentialStatus(resolved.config)).toBe('kode-storage')
    expect(readFileSync(getCredentialStorePath(), 'utf8')).toContain(
      'voice-test-key',
    )
    expect(JSON.stringify(redactVoiceConfig(resolved.config))).not.toContain(
      'voice-test-key',
    )
  })
})
