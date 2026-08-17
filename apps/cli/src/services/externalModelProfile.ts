import {
  storeOAuthCredentialBinding,
  type ModelProfile,
  type ProviderType,
} from '#core/utils/config'
import { getModelManager } from '#core/utils/model'

export type ExternalRuntimeProvider = Extract<
  ProviderType,
  'codex-oauth' | 'github-copilot' | 'grok-build'
>

export type ExternalRuntimeModel = {
  provider: ExternalRuntimeProvider
  model: string
  displayName: string
  reasoningEffort?: string
  /** Non-secret account label returned by the official runtime, if any. */
  accountLabel?: string
}

const PROVIDER_LABEL: Record<ExternalRuntimeProvider, string> = {
  'codex-oauth': 'Codex / ChatGPT (OAuth)',
  'github-copilot': 'GitHub Copilot (OAuth)',
  'grok-build': 'Grok Build (OAuth)',
}

const PROVIDER_CONTEXT_LENGTH: Record<ExternalRuntimeProvider, number> = {
  'codex-oauth': 128_000,
  'github-copilot': 128_000,
  'grok-build': 500_000,
}

export function getExternalRuntimeProfileId(
  provider: ExternalRuntimeProvider,
  model: string,
): string {
  return `${provider}:${model}`
}

/**
 * Persists a Kode-owned pointer separately from the external OAuth session.
 * This makes the user's choice to switch (or keep the current model) survive
 * restarts. Kode stores an opaque binding to the official runtime credential,
 * never the OAuth access or refresh token itself.
 */
export async function saveExternalRuntimeModelProfile(
  model: ExternalRuntimeModel,
  activateAsMain: boolean,
  getModelManagerFn: typeof getModelManager = getModelManager,
  storeOAuthBinding: typeof storeOAuthCredentialBinding = storeOAuthCredentialBinding,
  oauthBindingOptions: Parameters<typeof storeOAuthCredentialBinding>[1] = {},
): Promise<string> {
  const modelName = getExternalRuntimeProfileId(model.provider, model.model)
  const oauthCredentialId = storeOAuthBinding(model.provider, {
    accountLabel: model.accountLabel,
    ...oauthBindingOptions,
  })
  const profile: Omit<ModelProfile, 'createdAt' | 'isActive'> = {
    name: `${PROVIDER_LABEL[model.provider]} ${model.displayName}`,
    provider: model.provider,
    modelName,
    externalModelId: model.model,
    oauthCredentialId,
    apiKey: '',
    maxTokens: 32_768,
    contextLength: PROVIDER_CONTEXT_LENGTH[model.provider],
    ...(model.reasoningEffort
      ? { reasoningEffort: model.reasoningEffort }
      : {}),
  }
  return getModelManagerFn().upsertModel(profile, { activateAsMain })
}
