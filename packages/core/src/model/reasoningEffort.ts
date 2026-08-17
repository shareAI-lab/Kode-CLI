import type { ModelProfile } from '#config'

export const REASONING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

const LEGACY_GPT5_REASONING_EFFORTS: readonly ReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
]
const GPT56_REASONING_EFFORTS: readonly ReasoningEffort[] = [
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]
const PROVIDER_REASONING_EFFORTS: readonly ReasoningEffort[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
]

export function isReasoningEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value)
}

/**
 * Returns only strengths that Kode can safely pass to the selected runtime.
 * OAuth runtimes own their own capability checks; Copilot's CLI accepts the
 * complete documented set, while Codex/GPT-5 choices depend on model family.
 */
export function getSupportedReasoningEfforts(
  profile: ModelProfile,
): readonly ReasoningEffort[] {
  const modelId = (profile.externalModelId ?? profile.modelName).toLowerCase()

  if (profile.provider === 'github-copilot') return REASONING_EFFORTS
  if (modelId.includes('gpt-5.6') || modelId.includes('gpt-6')) {
    return GPT56_REASONING_EFFORTS
  }
  if (modelId.includes('gpt-5')) return LEGACY_GPT5_REASONING_EFFORTS
  if (modelId.includes('mimo') || modelId.includes('deepseek')) {
    return PROVIDER_REASONING_EFFORTS
  }
  return []
}
