import type OpenAI from 'openai'

import { debug as debugLogger } from '../internal/debug'
import {
  detectModelFamily,
  isDeepSeekReasonerModel,
} from '../internal/modelFamilies'

export interface ModelFeatures {
  usesMaxCompletionTokens: boolean
  supportsResponsesAPI?: boolean
  requiresTemperatureOne?: boolean
  supportsVerbosityControl?: boolean
  supportsCustomTools?: boolean
  supportsAllowedTools?: boolean
  /** Strip sampling params (temp/top_p/penalties) — reasoner models. */
  rejectsSamplingParams?: boolean
  /** Prefer stable message prefixes for disk/prefix cache. */
  prefersPrefixCache?: boolean
}

const MODEL_FEATURES: Record<string, ModelFeatures> = {
  o1: { usesMaxCompletionTokens: true, rejectsSamplingParams: true },
  'o1-preview': { usesMaxCompletionTokens: true, rejectsSamplingParams: true },
  'o1-mini': { usesMaxCompletionTokens: true, rejectsSamplingParams: true },
  'o1-pro': { usesMaxCompletionTokens: true, rejectsSamplingParams: true },
  'o3-mini': { usesMaxCompletionTokens: true, rejectsSamplingParams: true },
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
  'deepseek-reasoner': {
    usesMaxCompletionTokens: false,
    rejectsSamplingParams: true,
    prefersPrefixCache: true,
  },
  'deepseek-chat': {
    usesMaxCompletionTokens: false,
    prefersPrefixCache: true,
  },
  'deepseek-v4-flash': {
    usesMaxCompletionTokens: false,
    prefersPrefixCache: true,
  },
  'deepseek-v4-pro': {
    usesMaxCompletionTokens: false,
    prefersPrefixCache: true,
  },
  'mimo-v2.5-pro': {
    usesMaxCompletionTokens: true,
  },
  'mimo-v2.5': {
    usesMaxCompletionTokens: true,
  },
}

export function getModelFeatures(modelName: string): ModelFeatures {
  if (!modelName || typeof modelName !== 'string') {
    return { usesMaxCompletionTokens: false }
  }

  if (MODEL_FEATURES[modelName]) {
    return MODEL_FEATURES[modelName]
  }

  const lower = modelName.toLowerCase()
  const family = detectModelFamily(modelName)

  if (lower.includes('gpt-5') || family === 'gpt5') {
    return {
      usesMaxCompletionTokens: true,
      supportsResponsesAPI: true,
      requiresTemperatureOne: true,
      supportsVerbosityControl: true,
      supportsCustomTools: true,
      supportsAllowedTools: true,
    }
  }

  if (family === 'mimo') {
    return { usesMaxCompletionTokens: true }
  }

  if (family === 'deepseek') {
    return {
      usesMaxCompletionTokens: false,
      prefersPrefixCache: true,
      rejectsSamplingParams: isDeepSeekReasonerModel(modelName),
    }
  }

  if (family === 'o-series') {
    return {
      usesMaxCompletionTokens: true,
      rejectsSamplingParams: true,
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
  const family = detectModelFamily(opts.model)

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
  }

  // DeepSeek / o-series reasoner: drop sampling knobs the API rejects.
  if (features.rejectsSamplingParams || isDeepSeekReasonerModel(opts.model)) {
    delete opts.temperature
    delete opts.top_p
    delete opts.frequency_penalty
    delete opts.presence_penalty
    delete opts.logprobs
    delete opts.top_logprobs
    debugLogger.api('OPENAI_TRANSFORM_STRIP_SAMPLING', {
      model: opts.model,
      family,
    })
  }
}
