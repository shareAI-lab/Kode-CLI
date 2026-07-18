import { createAnthropicUsage } from '@kode/protocol/anthropic'

export function getMaxTokensFromProfile(modelProfile: any): number {
  return modelProfile?.maxTokens || 8000
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  return value as Record<string, unknown>
}

function numberOr(...candidates: unknown[]): number {
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c
    if (typeof c === 'string' && c.trim() && Number.isFinite(Number(c))) {
      return Number(c)
    }
  }
  return 0
}

function hasNumber(...candidates: unknown[]): boolean {
  return candidates.some(
    candidate =>
      (typeof candidate === 'number' && Number.isFinite(candidate)) ||
      (typeof candidate === 'string' &&
        candidate.trim() !== '' &&
        Number.isFinite(Number(candidate))),
  )
}

/**
 * Normalize provider usage into the Anthropic-shaped usage object used across
 * the stack. Special-cases:
 * - DeepSeek: `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
 * - OpenAI: `prompt_tokens_details.cached_tokens`
 * - MiMo/DeepSeek: `completion_tokens_details.reasoning_tokens`
 */
export function normalizeUsage(usage?: any) {
  if (!usage) {
    return createAnthropicUsage({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    })
  }

  const promptDetails =
    asRecord(usage.prompt_tokens_details) ||
    asRecord(usage.prompt_token_details) ||
    asRecord(usage.input_tokens_details)
  const completionDetails =
    asRecord(usage.completion_tokens_details) ||
    asRecord(usage.output_tokens_details)

  // DeepSeek reports cache hits and misses as a partition of prompt tokens.
  const deepseekCacheHit = numberOr(
    usage.prompt_cache_hit_tokens,
    usage.promptCacheHitTokens,
  )
  const deepseekCacheMiss = numberOr(
    usage.prompt_cache_miss_tokens,
    usage.promptCacheMissTokens,
  )
  const hasDeepseekCacheUsage = hasNumber(
    usage.prompt_cache_hit_tokens,
    usage.promptCacheHitTokens,
    usage.prompt_cache_miss_tokens,
    usage.promptCacheMissTokens,
  )
  const hasOpenAICacheUsage = hasNumber(
    promptDetails?.cached_tokens,
    promptDetails?.cache_read_input_tokens,
  )

  const cacheReadInputTokens = numberOr(
    usage.cache_read_input_tokens,
    usage.cacheReadInputTokens,
    deepseekCacheHit || undefined,
    promptDetails?.cached_tokens,
    promptDetails?.cache_read_input_tokens,
  )

  const cacheCreationInputTokens = numberOr(
    usage.cache_creation_input_tokens,
    usage.cacheCreationInputTokens,
  )

  const promptTokens = numberOr(
    usage.input_tokens,
    usage.prompt_tokens,
    usage.promptTokens,
    usage.inputTokens,
    hasDeepseekCacheUsage ? deepseekCacheHit + deepseekCacheMiss : undefined,
  )
  // Anthropic-shaped usage keeps cache reads separate from non-cached input.
  // DeepSeek misses are ordinary input, not cache writes.
  const inputTokens = hasDeepseekCacheUsage
    ? deepseekCacheMiss
    : hasOpenAICacheUsage
      ? Math.max(0, promptTokens - cacheReadInputTokens)
      : promptTokens

  const outputTokens = numberOr(
    usage.output_tokens,
    usage.completion_tokens,
    usage.completionTokens,
    usage.outputTokens,
  )

  const reasoningTokens = numberOr(
    usage.reasoningTokens,
    usage.reasoning_tokens,
    completionDetails?.reasoning_tokens,
  )

  return createAnthropicUsage({
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_input_tokens: cacheReadInputTokens,
    cache_creation_input_tokens: cacheCreationInputTokens,
    prompt_tokens: numberOr(
      usage.prompt_tokens,
      usage.input_tokens,
      promptTokens,
    ),
    completion_tokens: numberOr(usage.completion_tokens, outputTokens),
    promptTokens: numberOr(
      usage.promptTokens,
      usage.prompt_tokens,
      usage.input_tokens,
      promptTokens,
    ),
    completionTokens: numberOr(
      usage.completionTokens,
      usage.completion_tokens,
      outputTokens,
    ),
    totalTokens: numberOr(
      usage.totalTokens,
      usage.total_tokens,
      promptTokens + outputTokens,
    ),
    reasoningTokens: reasoningTokens || undefined,
  })
}

/**
 * Estimate USD cost with cache-aware rates when available.
 * Falls back to sonnet-shaped MODEL_COSTS when provider rates are unknown.
 */
export function estimateCostUSD(args: {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  rates: {
    inputPerMillionTokens: number
    outputPerMillionTokens: number
    promptCacheReadPerMillionTokens: number
    promptCacheWritePerMillionTokens: number
  }
}): number {
  const cacheRead = args.cacheReadInputTokens ?? 0
  const cacheWrite = args.cacheCreationInputTokens ?? 0
  // normalizeUsage reports only non-cached input here. Cache reads and writes
  // are priced separately under the shared Anthropic-shaped usage contract.
  const nonCachedInput = Math.max(0, args.inputTokens)

  return (
    (nonCachedInput / 1_000_000) * args.rates.inputPerMillionTokens +
    (args.outputTokens / 1_000_000) * args.rates.outputPerMillionTokens +
    (cacheRead / 1_000_000) * args.rates.promptCacheReadPerMillionTokens +
    (cacheWrite / 1_000_000) * args.rates.promptCacheWritePerMillionTokens
  )
}
