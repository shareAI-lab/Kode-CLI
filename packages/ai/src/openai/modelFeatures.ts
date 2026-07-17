import type OpenAI from 'openai'

import { debug as debugLogger } from '../internal/debug'

export interface ModelFeatures {
  usesMaxCompletionTokens: boolean
  supportsResponsesAPI?: boolean
  requiresTemperatureOne?: boolean
  supportsVerbosityControl?: boolean
  supportsCustomTools?: boolean
  supportsAllowedTools?: boolean
}

const MODEL_FEATURES: Record<string, ModelFeatures> = {
  o1: { usesMaxCompletionTokens: true },
  'o1-preview': { usesMaxCompletionTokens: true },
  'o1-mini': { usesMaxCompletionTokens: true },
  'o1-pro': { usesMaxCompletionTokens: true },
  'o3-mini': { usesMaxCompletionTokens: true },
  'gpt-5': {
    usesMaxCompletionTokens: true,
    supportsResponsesAPI: true,
    requiresTemperatureOne: true,
    supportsVerbosityControl: true,
    supportsCustomTools: true,
    supportsAllowedTools: true,
  },
  'gpt-5-mini': {
    usesMaxCompletionTokens: true,
    supportsResponsesAPI: true,
    requiresTemperatureOne: true,
    supportsVerbosityControl: true,
    supportsCustomTools: true,
    supportsAllowedTools: true,
  },
  'gpt-5-nano': {
    usesMaxCompletionTokens: true,
    supportsResponsesAPI: true,
    requiresTemperatureOne: true,
    supportsVerbosityControl: true,
    supportsCustomTools: true,
    supportsAllowedTools: true,
  },
  'gpt-5-chat-latest': {
    usesMaxCompletionTokens: true,
    supportsResponsesAPI: false,
    requiresTemperatureOne: true,
    supportsVerbosityControl: true,
  },
}

export function getModelFeatures(modelName: string): ModelFeatures {
  if (!modelName || typeof modelName !== 'string') {
    return { usesMaxCompletionTokens: false }
  }

  if (MODEL_FEATURES[modelName]) {
    return MODEL_FEATURES[modelName]
  }

  if (modelName.toLowerCase().includes('gpt-5')) {
    return {
      usesMaxCompletionTokens: true,
      supportsResponsesAPI: true,
      requiresTemperatureOne: true,
      supportsVerbosityControl: true,
      supportsCustomTools: true,
      supportsAllowedTools: true,
    }
  }

  for (const [key, features] of Object.entries(MODEL_FEATURES)) {
    if (modelName.includes(key)) {
      return features
    }
  }

  return { usesMaxCompletionTokens: false }
}

export function applyModelSpecificTransformations(
  opts: OpenAI.ChatCompletionCreateParams,
): void {
  if (!opts.model || typeof opts.model !== 'string') {
    return
  }

  const features = getModelFeatures(opts.model)
  const isGPT5 = opts.model.toLowerCase().includes('gpt-5')

  if (isGPT5 || features.usesMaxCompletionTokens) {
    if ('max_tokens' in opts && !('max_completion_tokens' in opts)) {
      debugLogger.api('OPENAI_TRANSFORM_MAX_TOKENS', {
        model: opts.model,
        from: opts.max_tokens,
      })
      opts.max_completion_tokens = opts.max_tokens
      delete opts.max_tokens
    }

    if (features.requiresTemperatureOne && 'temperature' in opts) {
      if (opts.temperature !== 1 && opts.temperature !== undefined) {
        debugLogger.api('OPENAI_TRANSFORM_TEMPERATURE', {
          model: opts.model,
          from: opts.temperature,
          to: 1,
        })
        opts.temperature = 1
      }
    }

    if (isGPT5) {
      delete opts.frequency_penalty
      delete opts.presence_penalty
      delete opts.logit_bias
      delete opts.user

      if (!opts.reasoning_effort && features.supportsVerbosityControl) {
        opts.reasoning_effort = 'medium'
      }
    }
  } else {
    if (
      features.usesMaxCompletionTokens &&
      'max_tokens' in opts &&
      !('max_completion_tokens' in opts)
    ) {
      opts.max_completion_tokens = opts.max_tokens
      delete opts.max_tokens
    }
  }
}
