import type { AssistantMessage, UserMessage } from '#core/query'

const MAX_PROMPT_CHARS = 500_000
const MAX_SYSTEM_PROMPT_CHARS = 120_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function serialize(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return '[Unserializable structured content]'
  }
}

function blockToText(block: unknown): string {
  if (typeof block === 'string') return block
  if (!isRecord(block)) return serialize(block)

  if (block.type === 'text' && typeof block.text === 'string') return block.text
  if (block.type === 'thinking' && typeof block.thinking === 'string') {
    return `[Earlier reasoning]\n${block.thinking}`
  }
  if (block.type === 'tool_result') {
    return `[Tool result]\n${serialize(block.content)}`
  }
  if (block.type === 'tool_use') {
    return `[Tool request: ${typeof block.name === 'string' ? block.name : 'unknown'}]\n${serialize(block.input)}`
  }
  return serialize(block)
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(blockToText).join('\n')
  return blockToText(content)
}

function truncateBeginning(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}\n[System instructions truncated by Kode]`
}

function truncateToLatest(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `[Earlier conversation omitted by Kode]\n${value.slice(-maxChars)}`
}

export function buildExternalRuntimePrompt(
  messages: (UserMessage | AssistantMessage)[],
): string {
  const transcript = messages
    .map(message => {
      const role = message.type === 'assistant' ? 'Assistant' : 'User'
      return `[${role}]\n${contentToText(message.message.content)}`
    })
    .join('\n\n')
  return truncateToLatest(transcript, MAX_PROMPT_CHARS)
}

export function buildExternalRuntimeSystemPrompt(
  systemPrompt: string[],
): string {
  return truncateBeginning(systemPrompt.join('\n'), MAX_SYSTEM_PROMPT_CHARS)
}

export function getExternalModelId(profile: {
  externalModelId?: string
  modelName: string
}): string {
  return profile.externalModelId || profile.modelName
}

export function getFinalTextFromExternalItems(items: unknown): string {
  if (!Array.isArray(items)) return ''
  return items
    .flatMap(item => {
      if (!isRecord(item) || item.type !== 'agentMessage') return []
      return typeof item.text === 'string' ? [item.text] : []
    })
    .join('\n')
}
