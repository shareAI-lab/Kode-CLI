import {
  hasStoredApiKey,
  readApiKey,
  readApiKeyFromEnvironment,
  storeApiKey,
} from './models/credentials'

/**
 * Persisted settings for the built-in voice path.
 *
 * Credentials deliberately never belong here: `apiKeyEnv` is only the name of
 * an environment variable and credential-store entry. This keeps ~/.kode.json
 * safe to inspect and share.
 */
export type VoiceLanguage = 'auto' | 'zh' | 'en'

export type VoiceConfig = {
  provider: 'mimo'
  /** The MiMo-compatible API root, including the /v1 path. */
  baseURL: string
  /** Name, not value, of the environment variable containing the API key. */
  apiKeyEnv: string
  asrModel: string
  ttsModel: string
  ttsVoice: string
  language: VoiceLanguage
  /** Whether a completed normal assistant reply is read aloud. */
  speakResponses: boolean
  /** A conservative cap keeps uncompressed WAV uploads below MiMo's 10 MB limit. */
  maxRecordingSeconds: number
  /** Avoid unexpectedly synthesizing a long tool-heavy answer. */
  maxReplyCharacters: number
}

export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  provider: 'mimo',
  baseURL: 'https://api.xiaomimimo.com/v1',
  apiKeyEnv: 'MIMO_API_KEY',
  asrModel: 'mimo-v2.5-asr',
  ttsModel: 'mimo-v2.5-tts',
  ttsVoice: 'mimo_default',
  language: 'auto',
  speakResponses: true,
  maxRecordingSeconds: 120,
  maxReplyCharacters: 1200,
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u
const LANGUAGES = new Set<VoiceLanguage>(['auto', 'zh', 'en'])
const MAX_RECORDING_SECONDS = 180
const MAX_REPLY_CHARACTERS = 4_000

export type VoiceConfigValidation =
  { ok: true; config: VoiceConfig } | { ok: false; message: string }

type VoiceConfigError = Extract<VoiceConfigValidation, { ok: false }>

export type VoiceCredentialStatus = 'environment' | 'kode-storage' | 'missing'

function stringSetting(
  value: unknown,
  fallback: string,
  label: string,
): string | VoiceConfigError {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { ok: false, message: `voice.${label} must be a non-empty string.` }
  }
  return value.trim()
}

function integerSetting(
  value: unknown,
  fallback: number,
  label: string,
  min: number,
  max: number,
): number | VoiceConfigError {
  if (value === undefined) return fallback
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    return {
      ok: false,
      message: `voice.${label} must be an integer from ${min} to ${max}.`,
    }
  }
  return value
}

function isVoiceConfigError(value: unknown): value is VoiceConfigError {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    (value as { ok?: unknown }).ok === false
  )
}

/**
 * Validate untrusted JSON from the global config before any network or native
 * audio action. Unknown keys are ignored so future config versions stay
 * forwards-compatible, while invalid supported keys fail closed.
 */
export function resolveVoiceConfig(value: unknown): VoiceConfigValidation {
  if (value === undefined) return { ok: true, config: DEFAULT_VOICE_CONFIG }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: 'voice configuration must be an object.' }
  }

  const raw = value as Record<string, unknown>
  if (raw.provider !== undefined && raw.provider !== 'mimo') {
    return {
      ok: false,
      message: 'voice.provider currently supports only "mimo".',
    }
  }

  const baseURL = stringSetting(
    raw.baseURL,
    DEFAULT_VOICE_CONFIG.baseURL,
    'baseURL',
  )
  const apiKeyEnv = stringSetting(
    raw.apiKeyEnv,
    DEFAULT_VOICE_CONFIG.apiKeyEnv,
    'apiKeyEnv',
  )
  const asrModel = stringSetting(
    raw.asrModel,
    DEFAULT_VOICE_CONFIG.asrModel,
    'asrModel',
  )
  const ttsModel = stringSetting(
    raw.ttsModel,
    DEFAULT_VOICE_CONFIG.ttsModel,
    'ttsModel',
  )
  const ttsVoice = stringSetting(
    raw.ttsVoice,
    DEFAULT_VOICE_CONFIG.ttsVoice,
    'ttsVoice',
  )
  const maxRecordingSeconds = integerSetting(
    raw.maxRecordingSeconds,
    DEFAULT_VOICE_CONFIG.maxRecordingSeconds,
    'maxRecordingSeconds',
    1,
    MAX_RECORDING_SECONDS,
  )
  const maxReplyCharacters = integerSetting(
    raw.maxReplyCharacters,
    DEFAULT_VOICE_CONFIG.maxReplyCharacters,
    'maxReplyCharacters',
    1,
    MAX_REPLY_CHARACTERS,
  )
  const values = [
    baseURL,
    apiKeyEnv,
    asrModel,
    ttsModel,
    ttsVoice,
    maxRecordingSeconds,
    maxReplyCharacters,
  ]
  const invalid = values.find(isVoiceConfigError)
  if (invalid) return invalid

  // Every possible error is returned above. The individual values are now the
  // validated scalar variants of their helper return types.
  const validBaseURL = baseURL as string
  const validApiKeyEnv = apiKeyEnv as string
  const validAsrModel = asrModel as string
  const validTtsModel = ttsModel as string
  const validTtsVoice = ttsVoice as string
  const validMaxRecordingSeconds = maxRecordingSeconds as number
  const validMaxReplyCharacters = maxReplyCharacters as number

  let parsedURL: URL
  try {
    parsedURL = new URL(validBaseURL)
  } catch {
    return { ok: false, message: 'voice.baseURL must be an absolute URL.' }
  }
  const localHttp =
    parsedURL.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(parsedURL.hostname)
  if (parsedURL.protocol !== 'https:' && !localHttp) {
    return {
      ok: false,
      message:
        'voice.baseURL must use HTTPS (except a loopback development proxy).',
    }
  }
  if (!ENV_NAME.test(validApiKeyEnv)) {
    return {
      ok: false,
      message: 'voice.apiKeyEnv must be a valid environment variable name.',
    }
  }
  if (
    raw.language !== undefined &&
    !LANGUAGES.has(raw.language as VoiceLanguage)
  ) {
    return { ok: false, message: 'voice.language must be auto, zh, or en.' }
  }
  if (
    raw.speakResponses !== undefined &&
    typeof raw.speakResponses !== 'boolean'
  ) {
    return { ok: false, message: 'voice.speakResponses must be true or false.' }
  }

  return {
    ok: true,
    config: {
      provider: 'mimo',
      baseURL: parsedURL.toString().replace(/\/$/u, ''),
      apiKeyEnv: validApiKeyEnv,
      asrModel: validAsrModel,
      ttsModel: validTtsModel,
      ttsVoice: validTtsVoice,
      language:
        (raw.language as VoiceLanguage | undefined) ??
        DEFAULT_VOICE_CONFIG.language,
      speakResponses:
        (raw.speakResponses as boolean | undefined) ??
        DEFAULT_VOICE_CONFIG.speakResponses,
      maxRecordingSeconds: validMaxRecordingSeconds,
      maxReplyCharacters: validMaxReplyCharacters,
    },
  }
}

export function redactVoiceConfig(
  config: VoiceConfig,
): Record<string, unknown> {
  const credentialStatus = getVoiceCredentialStatus(config)
  return {
    provider: config.provider,
    baseURL: config.baseURL,
    apiKeyEnv: config.apiKeyEnv,
    apiKeyConfigured: credentialStatus !== 'missing',
    apiKeySource: credentialStatus,
    asrModel: config.asrModel,
    ttsModel: config.ttsModel,
    ttsVoice: config.ttsVoice,
    language: config.language,
    speakResponses: config.speakResponses,
    maxRecordingSeconds: config.maxRecordingSeconds,
    maxReplyCharacters: config.maxReplyCharacters,
  }
}

/**
 * An environment value takes precedence so managed runtime configuration can
 * override the local owner-only credential without exposing either value.
 */
export function getVoiceCredentialStatus(
  config: VoiceConfig,
): VoiceCredentialStatus {
  if (readApiKeyFromEnvironment(config.apiKeyEnv)) return 'environment'
  return hasStoredApiKey(config.apiKeyEnv) ? 'kode-storage' : 'missing'
}

export function readVoiceApiKey(config: VoiceConfig): string | undefined {
  return readApiKey(config.apiKeyEnv)
}

/**
 * Persist a user-pasted key in Kode's owner-only credential store, never in
 * the ordinary global configuration file.
 */
export function storeVoiceApiKey(config: VoiceConfig, apiKey: string): void {
  storeApiKey(config.apiKeyEnv, apiKey)
}
