/**
 * Lightweight model-family detection for provider-specific request shaping.
 * Keep heuristics string-based so hosts do not need capability registries.
 */

export type ModelFamily =
  | 'deepseek'
  | 'mimo'
  | 'gpt5'
  | 'o-series'
  | 'glm'
  | 'kimi'
  | 'qwen'
  | 'generic'

export function detectModelFamily(
  modelName: string | null | undefined,
): ModelFamily {
  const name = (modelName || '').toLowerCase()
  if (!name) return 'generic'
  if (name.includes('deepseek') || name.startsWith('ds-')) return 'deepseek'
  if (name.startsWith('mimo-') || name.includes('mimo')) return 'mimo'
  if (name.includes('gpt-5') || name.includes('gpt5')) return 'gpt5'
  if (
    name.startsWith('o1') ||
    name.startsWith('o3') ||
    name.startsWith('o4') ||
    name.includes('o1-') ||
    name.includes('o3-')
  ) {
    return 'o-series'
  }
  if (name.includes('glm') || name.includes('chatglm')) return 'glm'
  if (name.includes('kimi') || name.includes('moonshot')) return 'kimi'
  if (name.includes('qwen') || name.includes('qwq')) return 'qwen'
  return 'generic'
}

/** DeepSeek reasoner / thinking-mode aliases (legacy + v4 thinking). */
export function isDeepSeekReasonerModel(
  modelName: string | null | undefined,
): boolean {
  const name = (modelName || '').toLowerCase()
  return (
    name.includes('deepseek-reasoner') ||
    (name.includes('reasoner') && name.includes('deepseek'))
  )
}

export function isDeepSeekModel(modelName: string | null | undefined): boolean {
  return detectModelFamily(modelName) === 'deepseek'
}

/**
 * Whether this model exposes OpenAI-style prefix/disk prompt caching that
 * benefits from stable message prefixes (system first, append-only history).
 */
export function supportsPrefixPromptCache(
  modelName: string | null | undefined,
  provider?: string | null,
): boolean {
  const family = detectModelFamily(modelName)
  if (family === 'deepseek') return true
  // OpenAI-compatible gateways often pass DeepSeek cache fields through.
  const p = (provider || '').toLowerCase()
  if (p === 'deepseek') return true
  return false
}
