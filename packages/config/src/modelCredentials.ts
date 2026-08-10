import type { ModelProfile } from './schema'

const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Validate a reference without resolving its value. This is safe to use in UI
 * flows because it never reads or displays the secret itself.
 */
export function validateApiKeyEnvironmentReference(
  value: string,
): string | null {
  const trimmed = value.trim()
  if (!trimmed) return 'Enter the name of an environment variable.'
  if (!ENVIRONMENT_VARIABLE_NAME.test(trimmed)) {
    return 'Use letters, digits, and underscores; the name cannot start with a digit.'
  }
  return null
}

export function suggestedApiKeyEnvironmentReference(provider: string): string {
  const normalizedProvider =
    provider === 'glm-coding'
      ? 'glm'
      : provider === 'minimax-coding'
        ? 'minimax'
        : provider
  const sanitizedProvider = normalizedProvider.replace(/[^a-z0-9]/gi, '_')
  return `${sanitizedProvider.toUpperCase()}_API_KEY`
}

/**
 * Resolve credentials only at a request boundary. Configuration UIs retain and
 * display the reference, never the value returned here.
 */
export function resolveModelApiKey(
  profile: Pick<ModelProfile, 'apiKey' | 'apiKeyEnv'>,
): string {
  const envName = profile.apiKeyEnv?.trim()
  if (envName) return process.env[envName]?.trim() || ''
  return profile.apiKey
}

export function withResolvedModelApiKey(profile: ModelProfile): ModelProfile {
  const apiKey = resolveModelApiKey(profile)
  return apiKey === profile.apiKey ? profile : { ...profile, apiKey }
}
