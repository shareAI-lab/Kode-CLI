/**
 * Resolve OpenAI reasoning_effort without pulling the full thinking pipeline.
 * Mirrors core getReasoningEffort behavior, including correct handling of
 * `low` (numeric 0 must not be treated as missing).
 */
export function resolveReasoningEffort(args: {
  modelProfile?: {
    reasoningEffort?: string
  } | null
  thinkingTokens?: number
  fallbackEffort?: string
}): 'low' | 'medium' | 'high' | null {
  const thinkingTokens =
    typeof args.thinkingTokens === 'number' &&
    Number.isFinite(args.thinkingTokens)
      ? Math.max(0, args.thinkingTokens)
      : 0

  const raw =
    args.modelProfile?.reasoningEffort ?? args.fallbackEffort ?? 'medium'
  const reasoningEffort =
    raw === 'high' || raw === 'medium' || raw === 'low'
      ? raw
      : raw === 'minimal'
        ? 'low'
        : 'medium'

  const maxEffort =
    reasoningEffort === 'high'
      ? 2
      : reasoningEffort === 'medium'
        ? 1
        : reasoningEffort === 'low'
          ? 0
          : null
  if (maxEffort === null) return null

  let effort = 0
  if (thinkingTokens < 10_000) {
    effort = 0
  } else if (thinkingTokens >= 10_000 && thinkingTokens < 30_000) {
    effort = 1
  } else {
    effort = 2
  }

  if (effort > maxEffort) {
    return maxEffort === 2 ? 'high' : maxEffort === 1 ? 'medium' : 'low'
  }

  return effort === 2 ? 'high' : effort === 1 ? 'medium' : 'low'
}
