export const MODEL_COSTS = {
  haiku: {
    inputPerMillionTokens: 0.8,
    outputPerMillionTokens: 4,
    promptCacheWritePerMillionTokens: 1,
    promptCacheReadPerMillionTokens: 0.08,
  },
  sonnet: {
    inputPerMillionTokens: 3,
    outputPerMillionTokens: 15,
    promptCacheWritePerMillionTokens: 3.75,
    promptCacheReadPerMillionTokens: 0.3,
  },
  /**
   * DeepSeek V4 Flash (approx public rates). Cache hit is ~50x cheaper than
   * cache miss on input — keep prefixes stable to maximize hits.
   */
  deepseekFlash: {
    inputPerMillionTokens: 0.14,
    outputPerMillionTokens: 0.28,
    promptCacheWritePerMillionTokens: 0,
    promptCacheReadPerMillionTokens: 0.0028,
  },
  /** DeepSeek V4 Pro approx rates (cache read heavily discounted). */
  deepseekPro: {
    inputPerMillionTokens: 0.435,
    outputPerMillionTokens: 0.87,
    promptCacheWritePerMillionTokens: 0,
    promptCacheReadPerMillionTokens: 0.003625,
  },
} as const

export type ModelCostTier = keyof typeof MODEL_COSTS

/** Pick a cost tier for rough USD estimates from model name. */
export function resolveModelCostTier(
  modelName: string | null | undefined,
): ModelCostTier {
  const name = (modelName || '').toLowerCase()
  if (name.includes('deepseek')) {
    if (name.includes('pro')) {
      return 'deepseekPro'
    }
    return 'deepseekFlash'
  }
  if (name.includes('haiku')) return 'haiku'
  return 'sonnet'
}

export const MCP_DEFAULTS = {
  healthCheckIntervalMs: 5_000,
  failedRetryIntervalMs: 30_000,
} as const

export const ENGINE_DEFAULTS = {
  mainQueryTemperature: 1,
  contextReserveRatio: 0.1,
  contextReserveCapTokens: 20_000,
  autoCompactMarginTokens: 13_000,
  warningMarginTokens: 20_000,
  errorMarginTokens: 20_000,
} as const

export const PRODUCT_NAME = 'Kode'
