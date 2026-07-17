import { last } from 'lodash-es'
import type { Message } from '#core/query'
import { getGlobalConfig } from '#config'
import { getModelManager } from './model'

const ULTRATHINK_TOKENS = 31_999
const ULTRATHINK_REGEX = /\bultrathink\b/i

export async function getMaxThinkingTokens(
  messages: Message[],
  options?: { thinkingMode?: 'auto' | 'enabled' | 'disabled' },
): Promise<number> {
  if (process.env.MAX_THINKING_TOKENS) {
    const tokens = parseInt(process.env.MAX_THINKING_TOKENS, 10)
    return Number.isFinite(tokens) && tokens > 0 ? tokens : 0
  }

  if (Boolean(process.env.THINK_TOOL)) {
    return 0
  }

  const thinkingMode =
    options?.thinkingMode ?? getGlobalConfig().thinkingMode ?? 'auto'
  if (thinkingMode === 'disabled') {
    return 0
  }

  if (thinkingMode === 'enabled') {
    return ULTRATHINK_TOKENS
  }

  const lastMessage = last(messages)
  if (
    lastMessage?.type !== 'user' ||
    typeof lastMessage.message.content !== 'string'
  ) {
    return 0
  }

  return ULTRATHINK_REGEX.test(lastMessage.message.content)
    ? ULTRATHINK_TOKENS
    : 0
}

export async function getReasoningEffort(
  modelProfile: any,
  messages: Message[],
  options?: {
    thinkingTokens?: number
    thinkingMode?: 'auto' | 'enabled' | 'disabled'
  },
): Promise<'low' | 'medium' | 'high' | null> {
  const thinkingTokens =
    options?.thinkingTokens ??
    (await getMaxThinkingTokens(messages, {
      thinkingMode: options?.thinkingMode,
    }))

  // Get reasoning effort from ModelProfile first, then fallback to config
  let reasoningEffort: 'low' | 'medium' | 'high' | undefined
  if (modelProfile?.reasoningEffort) {
    const effort = modelProfile.reasoningEffort
    reasoningEffort =
      effort === 'high' || effort === 'medium' || effort === 'low'
        ? effort
        : effort === 'minimal'
          ? 'low'
          : 'medium'
  } else {
    const modelManager = getModelManager()
    const fallbackProfile = modelManager.getModel('main')
    const effort = fallbackProfile?.reasoningEffort
    reasoningEffort =
      effort === 'high' || effort === 'medium' || effort === 'low'
        ? effort
        : effort === 'minimal'
          ? 'low'
          : 'medium'
  }

  const maxEffort =
    reasoningEffort === 'high'
      ? 2
      : reasoningEffort === 'medium'
        ? 1
        : reasoningEffort === 'low'
          ? 0
          : null
  // `low` maps to 0 — must not treat it as missing with a falsy check.
  if (maxEffort === null) {
    return null
  }

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
