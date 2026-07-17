import type OpenAI from 'openai'

import {
  debug as debugLogger,
  getCurrentRequest,
} from '../internal/debug'

import { getModelFeatures } from './modelFeatures'
import { getCompletionWithProfile } from './completion'

/**
 * Legacy Chat Completions fallback for GPT-5-compatible profiles.
 *
 * Official OpenAI GPT-5 requests are routed through the Responses adapter
 * before reaching this helper. Third-party providers can still use this path
 * when they expose OpenAI-compatible Chat Completions only.
 */
export async function getGPT5CompletionWithProfile(
  modelProfile: unknown,
  opts: OpenAI.ChatCompletionCreateParams,
  attempt: number = 0,
  maxAttempts: number = 10,
  signal?: AbortSignal,
  requestHeadersProfile?: import('#core/ai/llm/restrictedClientCompat').RequestHeadersProfile,
): Promise<OpenAI.ChatCompletion | AsyncIterable<OpenAI.ChatCompletionChunk>> {
  const profile = modelProfile as { baseURL?: string; provider?: string } | null
  const features = getModelFeatures(opts.model)
  const isOfficialOpenAI =
    !profile?.baseURL || profile.baseURL.includes('api.openai.com')

  if (!isOfficialOpenAI) {
    debugLogger.api('GPT5_THIRD_PARTY_PROVIDER', {
      model: opts.model,
      baseURL: profile?.baseURL,
      provider: profile?.provider,
      supportsResponsesAPI: features.supportsResponsesAPI,
      requestId: getCurrentRequest()?.id,
    })

    debugLogger.api('GPT5_PROVIDER_THIRD_PARTY_NOTICE', {
      model: opts.model,
      provider: profile?.provider,
      baseURL: profile?.baseURL,
    })

    if (profile?.provider === 'azure') {
      delete opts.reasoning_effort
    } else if (profile?.provider === 'custom-openai') {
      debugLogger.api('GPT5_CUSTOM_PROVIDER_OPTIMIZATIONS', {
        model: opts.model,
        provider: profile?.provider,
      })
    }
  } else if (opts.stream) {
    debugLogger.api('GPT5_STREAMING_MODE', {
      model: opts.model,
      baseURL: profile?.baseURL || 'official',
      reason: 'legacy_chat_completions_fallback',
      requestId: getCurrentRequest()?.id,
    })

    debugLogger.api('GPT5_STREAMING_FALLBACK_TO_CHAT_COMPLETIONS', {
      model: opts.model,
      reason: 'legacy_chat_completions_fallback',
    })
  }

  debugLogger.api('USING_CHAT_COMPLETIONS_FOR_GPT5', {
    model: opts.model,
    baseURL: profile?.baseURL || 'official',
    provider: profile?.provider,
    reason: isOfficialOpenAI
      ? 'legacy_chat_completions_fallback'
      : 'third_party_provider',
    requestId: getCurrentRequest()?.id,
  })

  return await getCompletionWithProfile(
    modelProfile,
    opts,
    attempt,
    maxAttempts,
    signal,
    requestHeadersProfile,
  )
}
