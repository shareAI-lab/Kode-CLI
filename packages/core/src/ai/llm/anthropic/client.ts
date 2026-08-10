import Anthropic from '@anthropic-ai/sdk'
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk'
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk'
import chalk from 'chalk'

import {
  getAnthropicApiKey,
  getGlobalConfig,
  withResolvedModelApiKey,
} from '#core/utils/config'
import { USER_AGENT } from '#core/utils/http'
import {
  buildCompatHeaders,
  COMPAT_DEFAULT_TIMEOUT_MS,
  type RequestHeadersProfile,
} from '#core/ai/llm/restrictedClientCompat'
import {
  getModelManager,
  getVertexRegionForModel,
  isBedrockRuntimeEnabled,
  isVertexRuntimeEnabled,
} from '#core/utils/model'

let anthropicClient: Anthropic | AnthropicBedrock | AnthropicVertex | null =
  null

/**
 * Get the Anthropic client, creating it if it doesn't exist
 */
export function getAnthropicClient(
  model?: string,
  options?: { requestHeadersProfile?: RequestHeadersProfile },
): Anthropic | AnthropicBedrock | AnthropicVertex {
  const config = getGlobalConfig()
  const provider = config.primaryProvider
  const requestHeadersProfile = options?.requestHeadersProfile ?? 'kode'

  // Reset client if provider has changed to ensure correct configuration
  if (anthropicClient && provider) {
    // Always recreate client for provider-specific configurations
    anthropicClient = null
  }

  if (anthropicClient && requestHeadersProfile === 'kode') {
    return anthropicClient
  }

  const region = getVertexRegionForModel(model)

  const modelManager = getModelManager()
  const configuredProfile = modelManager.getModel('main')
  const modelProfile = configuredProfile
    ? withResolvedModelApiKey(configuredProfile)
    : null

  const defaultHeaders: { [key: string]: string } =
    requestHeadersProfile === 'compat'
      ? buildCompatHeaders()
      : {
          'x-app': 'cli',
          'User-Agent': USER_AGENT,
        }

  const ARGS = {
    defaultHeaders,
    maxRetries: 0, // Disabled auto-retry in favor of manual implementation
    timeout: parseInt(
      process.env.API_TIMEOUT_MS ||
        String(
          requestHeadersProfile === 'compat'
            ? COMPAT_DEFAULT_TIMEOUT_MS
            : 60 * 1000,
        ),
      10,
    ),
  }
  if (isBedrockRuntimeEnabled()) {
    const client = new AnthropicBedrock(ARGS)
    anthropicClient = client
    return client
  }
  if (isVertexRuntimeEnabled()) {
    const vertexArgs = {
      ...ARGS,
      region: region || process.env.CLOUD_ML_REGION || 'us-east5',
    }
    const client = new AnthropicVertex(vertexArgs)
    anthropicClient = client
    return client
  }

  let apiKey: string
  let baseURL: string | undefined

  if (modelProfile) {
    apiKey = modelProfile.apiKey || ''
    baseURL = modelProfile.baseURL
  } else {
    apiKey = getAnthropicApiKey()
    baseURL = undefined
  }

  if (process.env.USER_TYPE === 'ant' && !apiKey && provider === 'anthropic') {
    console.error(
      chalk.red(
        '[ANT-ONLY] Missing API key. Configure an API key in your model profile or environment variables.',
      ),
    )
  }

  // Create client with custom baseURL for BigDream/OpenDev
  // Anthropic SDK will append the appropriate paths (like /v1/messages)
  const clientConfig = {
    apiKey,
    dangerouslyAllowBrowser: true,
    ...ARGS,
    ...(baseURL && { baseURL }), // Use baseURL directly, SDK will handle API versioning
  }

  const client = new Anthropic(clientConfig)
  if (requestHeadersProfile === 'kode') {
    anthropicClient = client
  }
  return client
}

/**
 * Reset the Anthropic client to null, forcing a new client to be created on next use
 */
export function resetAnthropicClient(): void {
  anthropicClient = null
}
