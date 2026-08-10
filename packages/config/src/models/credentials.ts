import type { ModelProfile, ProviderType } from '../schema'

function normalizeProviderForApiKeyEnvVar(provider: string): string {
  if (provider === 'glm-coding') return 'glm'
  if (provider === 'minimax-coding') return 'minimax'
  return provider
}

export function providerUsesApiKey(provider: ProviderType): boolean {
  return provider !== 'ollama'
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

export type ModelCredentialStatus =
  { success: true; apiKey: string } | { success: false; error: string }

export function getModelCredentialStatus(
  profile: ModelProfile,
): ModelCredentialStatus {
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
        `Set ${suggestedEnvVar ?? 'a provider API key variable'}, update this profile to reference it, and rotate any API key previously stored in configuration.`,
    }
  }

  const apiKey = readApiKeyFromEnvironment(envVarName)
  if (!apiKey) {
    return {
      success: false,
      error:
        `Model '${profile.name}' is blocked for safety because ${envVarName} is not set in this process. ` +
        'Set the variable, then retry. Rotate any API key previously stored in configuration.',
    }
  }

  return { success: true, apiKey }
}

export function redactModelProfileCredential(
  profile: ModelProfile,
): ModelProfile {
  return { ...profile, apiKey: '' }
}
