import { providers } from '#core/constants/models'
import type { ModelPointerType, ProviderType } from '#core/utils/config'
import {
  getSuggestedApiKeyEnvVar,
  setAllPointersToModel,
  setModelPointer,
} from '#core/utils/config'
import { getModelManager } from '#core/utils/model'
import type { RequestStrategy } from '#config'

import { DEFAULT_CONTEXT_LENGTH, DEFAULT_MAX_TOKENS } from '../options'

type Params = {
  provider: ProviderType
  model: string
  providerBaseUrl: string
  resourceName: string
  customBaseUrl: string
  apiKeyEnv?: string
  maxTokens: string
  contextLength: number
  reasoningEffort: any
  requestStrategy?: RequestStrategy
  /** Save the profile without replacing Kode's current main-model pointer. */
  activateAsMain?: boolean
  getModelManagerFn?: typeof getModelManager
}

export async function saveModelConfiguration({
  provider,
  model,
  providerBaseUrl,
  resourceName,
  customBaseUrl,
  apiKeyEnv,
  maxTokens,
  contextLength,
  reasoningEffort,
  requestStrategy,
  activateAsMain,
  getModelManagerFn,
}: Params): Promise<string> {
  const providerCatalog = providers as Record<
    string,
    { name: string; baseURL: string }
  >
  const normalizedModel = model.trim()
  let baseURL =
    providerBaseUrl.trim() || providerCatalog[provider]?.baseURL || ''
  let actualProvider = provider

  // For Anthropic provider, use defaults
  if (provider === 'anthropic') {
    actualProvider = 'anthropic'
    baseURL = baseURL || 'https://api.anthropic.com'
  }

  // For Azure, construct the baseURL using the resource name
  if (provider === 'azure') {
    baseURL = `https://${resourceName.trim()}.openai.azure.com/openai/deployments/${normalizedModel}`
  }
  // For custom OpenAI-compatible API, use the custom base URL
  else if (provider === 'custom-openai') {
    baseURL = customBaseUrl.trim()
  }

  const modelManager = (getModelManagerFn ?? getModelManager)()

  // Generate a unique name for the model
  // If model is empty (for providers without model selection), use provider name
  const displayModel = normalizedModel || 'default'
  const modelDisplayName =
    `${providerCatalog[actualProvider]?.name || actualProvider} ${displayModel}`.trim()
  const credentialEnv = apiKeyEnv ?? getSuggestedApiKeyEnvVar(actualProvider)

  const modelConfig = {
    name: modelDisplayName,
    provider: actualProvider,
    modelName: normalizedModel || actualProvider, // Use provider name if no specific model
    baseURL: baseURL,
    // API keys are never persisted in model profiles. Requests resolve this
    // reference from the environment or Kode's owner-only credential store.
    apiKey: '',
    ...(credentialEnv ? { apiKeyEnv: credentialEnv } : {}),
    maxTokens: parseInt(maxTokens) || DEFAULT_MAX_TOKENS,
    contextLength: contextLength || DEFAULT_CONTEXT_LENGTH,
    reasoningEffort,
    ...(requestStrategy ? { requestStrategy } : {}),
  }

  return await modelManager.upsertModel(modelConfig, { activateAsMain })
}

type ApplyPointersParams = {
  modelId: string
  isOnboarding: boolean
  targetPointer?: ModelPointerType
  activateAsMain?: boolean
  setModelPointerFn?: typeof setModelPointer
  setAllPointersToModelFn?: typeof setAllPointersToModel
}

export function applyPointersForNewModel({
  modelId,
  isOnboarding,
  targetPointer,
  setModelPointerFn,
  setAllPointersToModelFn,
  activateAsMain = true,
}: ApplyPointersParams) {
  if (!activateAsMain) return
  const setModelPointerImpl = setModelPointerFn ?? setModelPointer
  const setAllPointersImpl = setAllPointersToModelFn ?? setAllPointersToModel

  // Always set the main model pointer to the newly added model
  // This ensures the user immediately starts using the model they just configured
  setModelPointerImpl('main', modelId)

  // Handle additional pointer assignments
  if (isOnboarding) {
    // First-time setup: set all pointers to this model
    setAllPointersImpl(modelId)
  } else if (targetPointer && targetPointer !== 'main') {
    // Specific pointer configuration: also set target pointer
    setModelPointerImpl(targetPointer, modelId)
  }
}
