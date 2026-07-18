/**
 * DeepSeek disk/prefix caches hit only when the request
 * **prefix** exactly matches a previously persisted unit. Multi-turn agent
 * loops already append; we still normalize avoidable prefix churn:
 *
 * - Merge consecutive system messages into one stable leading system block
 * - Preserve every non-system message exactly as provided
 *
 * See: https://api-docs.deepseek.com/guides/kv_cache/
 */

import type OpenAI from 'openai'

/**
 * Stabilize chat messages for prefix-cache friendliness without changing
 * conversational semantics of tool/assistant turns.
 */
export function stabilizeMessagesForPrefixCache(
  messages: OpenAI.ChatCompletionMessageParam[],
): OpenAI.ChatCompletionMessageParam[] {
  if (!Array.isArray(messages) || messages.length === 0) return messages

  const out: OpenAI.ChatCompletionMessageParam[] = []
  let pendingSystem: string[] = []

  const flushSystem = () => {
    if (pendingSystem.length === 0) return
    out.push({
      role: 'system',
      content: pendingSystem.join('\n\n'),
    })
    pendingSystem = []
  }

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue

    if (
      message.role === 'system' &&
      typeof message.content === 'string' &&
      message.content.trim()
    ) {
      pendingSystem.push(message.content)
      continue
    }

    flushSystem()
    out.push(message)
  }

  flushSystem()
  return out
}
