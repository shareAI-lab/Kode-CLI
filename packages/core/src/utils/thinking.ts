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
    /** Voice turns answer quickly; deep reasoning is unnecessary. */
    isVoice?: boolean
  },
): Promise<
  'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
> {
  // Anthropic thinking-token budgets and OpenAI reasoning effort are separate
  // controls. The selected OpenAI profile is therefore authoritative; silently
  // reducing "high" to "low" when no ultrathink token budget was present made
  // the ModelSelector value misleading and prevented the newest effort levels.
  void messages
  void options

  // Voice turns skip deep reasoning for a snappy reply.
  if (options?.isVoice) {
    return 'none'
  }

  const configured =
    modelProfile?.reasoningEffort ??
    getModelManager().getModel('main')?.reasoningEffort
  if (configured === undefined || configured === null || configured === '') {
    // Automatic allocation: reasoning models default to a balanced effort so
    // thinking is enabled by default instead of being silently disabled.
    return 'medium'
  }
  if (
    configured === 'none' ||
    configured === 'minimal' ||
    configured === 'low' ||
    configured === 'medium' ||
    configured === 'high' ||
    configured === 'xhigh' ||
    configured === 'max'
  ) {
    return configured
  }
  return 'medium'
}
