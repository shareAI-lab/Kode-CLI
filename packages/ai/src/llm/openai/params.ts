import OpenAI from 'openai'

import {
  detectModelFamily,
  isDeepSeekModel,
  isDeepSeekReasonerModel,
} from '../../internal/modelFamilies'

export function isGPT5Model(modelName: string): boolean {
  return (
    modelName.startsWith('gpt-5') || modelName.toLowerCase().includes('gpt-5')
  )
}

export function isMiMoModel(modelName: string): boolean {
  return modelName.toLowerCase().startsWith('mimo-')
}

/**
 * MiMo / DeepSeek thinking burns completion budget and can break tool_calls.
 * Enable only for medium/high effort without tools.
 */
export function shouldDisableProviderThinking(args: {
  model: string
  toolSchemasLength: number
  reasoningEffort?: string | null
  provider?: string | null
}): boolean {
  const family = detectModelFamily(args.model)
  const isDeepSeek =
    family === 'deepseek' || args.provider?.trim().toLowerCase() === 'deepseek'
  if (family !== 'mimo' && !isDeepSeek) return false
  if (args.toolSchemasLength > 0) return true
  const effort = args.reasoningEffort
  return effort !== 'medium' && effort !== 'high'
}

/** @deprecated use shouldDisableProviderThinking */
export function shouldDisableMiMoThinking(args: {
  toolSchemasLength: number
  reasoningEffort?: string | null
}): boolean {
  return shouldDisableProviderThinking({
    model: 'mimo-v2.5-pro',
    toolSchemasLength: args.toolSchemasLength,
    reasoningEffort: args.reasoningEffort,
  })
}

export function buildOpenAIChatCompletionCreateParams(args: {
  model: string
  maxTokens: number
  messages: OpenAI.ChatCompletionMessageParam[]
  temperature: number
  stream: boolean
  toolSchemas: OpenAI.ChatCompletionTool[]
  stopSequences?: string[]
  reasoningEffort?: any
  /** Optional provider for provider-specific request shaping. */
  provider?: string | null
}): OpenAI.ChatCompletionCreateParams {
  const isGPT5 = isGPT5Model(args.model)
  const isMiMo = isMiMoModel(args.model)
  const isDeepSeek =
    isDeepSeekModel(args.model) ||
    args.provider?.trim().toLowerCase() === 'deepseek'
  const isReasoner = isDeepSeekReasonerModel(args.model)
  const family = detectModelFamily(args.model)

  // GPT-5 / MiMo / o-series prefer max_completion_tokens; DeepSeek still uses
  // max_tokens (OpenAI-compatible default). Reasoner also uses max_tokens.
  const usesMaxCompletionTokens = isGPT5 || isMiMo || family === 'o-series'

  const opts: OpenAI.ChatCompletionCreateParams = {
    model: args.model,
    ...(usesMaxCompletionTokens
      ? { max_completion_tokens: args.maxTokens }
      : { max_tokens: args.maxTokens }),
    messages: args.messages,
    temperature: args.temperature,
  }

  if (args.stopSequences && args.stopSequences.length > 0) {
    opts.stop = args.stopSequences
  }
  if (args.stream) {
    ;(opts as OpenAI.ChatCompletionCreateParams).stream = true
    opts.stream_options = {
      include_usage: true,
    }
  }

  if (args.toolSchemas.length > 0) {
    opts.tools = args.toolSchemas
    opts.tool_choice = 'auto'
  }

  const disableThinking = shouldDisableProviderThinking({
    model: args.model,
    toolSchemasLength: args.toolSchemas.length,
    reasoningEffort: args.reasoningEffort,
    provider: args.provider,
  })
  const enableDeepSeekThinking =
    !disableThinking &&
    isDeepSeek &&
    (args.reasoningEffort === 'medium' || args.reasoningEffort === 'high')

  if (disableThinking && (isMiMo || isDeepSeek)) {
    ;(
      opts as OpenAI.ChatCompletionCreateParams & {
        thinking?: { type: 'disabled' | 'enabled' }
      }
    ).thinking = { type: 'disabled' }
  } else if (enableDeepSeekThinking) {
    // DeepSeek V4 thinking mode (optional). Tools path never reaches here.
    ;(
      opts as OpenAI.ChatCompletionCreateParams & {
        thinking?: { type: 'disabled' | 'enabled' }
      }
    ).thinking = { type: 'enabled' }
  }

  // DeepSeek thinking and legacy reasoner do not support sampling controls.
  if (isReasoner || enableDeepSeekThinking) {
    delete (opts as { temperature?: number }).temperature
    delete (opts as { top_p?: number }).top_p
    delete (opts as { frequency_penalty?: number }).frequency_penalty
    delete (opts as { presence_penalty?: number }).presence_penalty
    delete (opts as { logprobs?: boolean }).logprobs
    delete (opts as { top_logprobs?: number }).top_logprobs
  }

  if (args.reasoningEffort) {
    opts.reasoning_effort = args.reasoningEffort
  }

  return opts
}
