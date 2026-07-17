import OpenAI from 'openai'
import {
  extractTextAndImageUrls,
  getImageUrlFromPart,
  toOpenAIImageUrlParts,
} from './visionContent'

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  return value as Record<string, unknown>
}

type AnthropicImageBlock = {
  type: 'image'
  source:
    | { type: 'base64'; media_type: string; data: string }
    | { type: 'url'; url: string }
}

type AnthropicTextBlock = { type: 'text'; text: string }
type AnthropicToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}
type AnthropicToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content: unknown
}

type AnthropicBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | { type: string }

type AnthropicLikeMessage = {
  message: {
    role: 'user' | 'assistant'
    content: string | AnthropicBlock[] | AnthropicBlock
  }
}

type ParsedAnthropicLikeMessage = {
  role: 'user' | 'assistant'
  blocks: AnthropicBlock[]
}

function parseMessages(
  messages: AnthropicLikeMessage[],
): ParsedAnthropicLikeMessage[] {
  return messages.map(message => {
    const blocks: AnthropicBlock[] = []
    if (typeof message.message.content === 'string') {
      blocks.push({ type: 'text', text: message.message.content })
    } else if (Array.isArray(message.message.content)) {
      blocks.push(...message.message.content)
    } else if (message.message.content) {
      blocks.push(message.message.content)
    }

    return {
      role: message.message.role,
      blocks,
    }
  })
}

function getToolUseId(block: AnthropicBlock): string | null {
  if (block.type !== 'tool_use') return null
  const id = (block as AnthropicToolUseBlock).id
  return typeof id === 'string' && id ? id : null
}

function getToolResultId(block: AnthropicBlock): string | null {
  if (block.type !== 'tool_result') return null
  const id = (block as AnthropicToolResultBlock).tool_use_id
  return typeof id === 'string' && id ? id : null
}

function getActiveNativeToolResultIds(
  messages: ParsedAnthropicLikeMessage[],
): Set<string> {
  let lastToolUseMessageIndex = -1
  let lastToolUseIds: string[] = []

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (!message || message.role !== 'assistant') continue
    const toolUseIds = message.blocks
      .map(getToolUseId)
      .filter((id): id is string => id !== null)
    if (toolUseIds.length === 0) continue
    lastToolUseMessageIndex = i
    lastToolUseIds = toolUseIds
  }

  if (lastToolUseMessageIndex === -1) return new Set()

  const resultIdsAfterLastToolUse = new Set<string>()
  for (const message of messages.slice(lastToolUseMessageIndex + 1)) {
    if (message.role === 'assistant') return new Set()
    for (const block of message.blocks) {
      const resultId = getToolResultId(block)
      if (resultId) resultIdsAfterLastToolUse.add(resultId)
    }
  }

  return new Set(lastToolUseIds.filter(id => resultIdsAfterLastToolUse.has(id)))
}

function stringifyToolInput(input: unknown): string {
  try {
    const json = JSON.stringify(input)
    return typeof json === 'string' ? json : String(input)
  } catch {
    return String(input)
  }
}

function formatHistoricalToolUse(block: AnthropicToolUseBlock): string {
  return [
    `Tool call ${block.name} (${block.id})`,
    `Input: ${stringifyToolInput(block.input)}`,
  ].join('\n')
}

function formatHistoricalToolResult(toolUseId: string, text: string): string {
  return [`Tool result for ${toolUseId}:`, text || '(empty output)'].join('\n')
}

export function convertAnthropicMessagesToOpenAIMessages(
  messages: AnthropicLikeMessage[],
): (
  OpenAI.ChatCompletionMessageParam | OpenAI.ChatCompletionToolMessageParam
)[] {
  const parsedMessages = parseMessages(messages)
  const activeNativeToolResultIds = getActiveNativeToolResultIds(parsedMessages)
  const openaiMessages: OpenAI.ChatCompletionMessageParam[] = []

  const toolResults: Record<
    string,
    {
      toolMessage: OpenAI.ChatCompletionToolMessageParam
      imageMessage?: OpenAI.ChatCompletionUserMessageParam
    }
  > = {}

  for (const message of parsedMessages) {
    const { blocks, role } = message
    const userContentParts: OpenAI.ChatCompletionContentPart[] = []
    const assistantTextParts: string[] = []
    const assistantToolCalls: OpenAI.ChatCompletionMessageToolCall[] = []
    const assistantToolCallIds = new Set<string>()

    for (const block of blocks) {
      if (block.type === 'text') {
        const record = asRecord(block)
        const text =
          record && typeof record.text === 'string' ? record.text : ''
        if (!text) continue
        if (role === 'user') {
          userContentParts.push({ type: 'text', text })
        } else if (role === 'assistant') {
          assistantTextParts.push(text)
        }
        continue
      }

      if (block.type === 'image' && role === 'user') {
        const imageUrl = getImageUrlFromPart(block as any)
        if (imageUrl) {
          userContentParts.push({
            type: 'image_url',
            image_url: { url: imageUrl },
          })
        }
        continue
      }

      if (block.type === 'tool_use') {
        const toolUseBlock = block as AnthropicToolUseBlock
        if (!activeNativeToolResultIds.has(toolUseBlock.id)) {
          assistantTextParts.push(formatHistoricalToolUse(toolUseBlock))
          continue
        }
        if (assistantToolCallIds.has(toolUseBlock.id)) {
          continue
        }
        assistantToolCallIds.add(toolUseBlock.id)
        assistantToolCalls.push({
          type: 'function',
          function: {
            name: toolUseBlock.name,
            arguments: stringifyToolInput(toolUseBlock.input),
          },
          id: toolUseBlock.id,
        })
        continue
      }

      if (block.type === 'tool_result') {
        const toolUseId = (block as AnthropicToolResultBlock).tool_use_id
        const rawToolContent = (block as AnthropicToolResultBlock).content
        const { text, imageUrls } = extractTextAndImageUrls(rawToolContent)

        if (!activeNativeToolResultIds.has(toolUseId)) {
          userContentParts.push({
            type: 'text',
            text: formatHistoricalToolResult(toolUseId, text),
          })
          userContentParts.push(...toOpenAIImageUrlParts(imageUrls))
          continue
        }

        const toolContent =
          text || (imageUrls.length > 0 ? '(image output attached)' : '')
        const result: {
          toolMessage: OpenAI.ChatCompletionToolMessageParam
          imageMessage?: OpenAI.ChatCompletionUserMessageParam
        } = {
          toolMessage: {
            role: 'tool',
            content: toolContent,
            tool_call_id: toolUseId,
          },
        }

        if (imageUrls.length > 0) {
          result.imageMessage = {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Image output from tool ${toolUseId}:`,
              },
              ...toOpenAIImageUrlParts(imageUrls),
            ],
          } as any
        }
        toolResults[toolUseId] = result
        continue
      }
    }

    if (role === 'user') {
      if (
        userContentParts.length === 1 &&
        userContentParts[0]?.type === 'text'
      ) {
        openaiMessages.push(<OpenAI.ChatCompletionUserMessageParam>{
          role: 'user',
          content: userContentParts[0].text,
        })
      } else if (userContentParts.length > 0) {
        openaiMessages.push(<OpenAI.ChatCompletionUserMessageParam>{
          role: 'user',
          content: userContentParts,
        })
      }
      continue
    }

    if (role === 'assistant') {
      const text = assistantTextParts.filter(Boolean).join('\n')
      if (assistantToolCalls.length > 0) {
        openaiMessages.push(<OpenAI.ChatCompletionAssistantMessageParam>{
          role: 'assistant',
          content: text ? text : undefined,
          tool_calls: assistantToolCalls,
        })
        continue
      }
      if (text) {
        openaiMessages.push(<OpenAI.ChatCompletionAssistantMessageParam>{
          role: 'assistant',
          content: text,
        })
      }
    }
  }

  const finalMessages: OpenAI.ChatCompletionMessageParam[] = []
  const emittedToolResultIds = new Set<string>()

  for (const message of openaiMessages) {
    finalMessages.push(message)

    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        if (emittedToolResultIds.has(toolCall.id)) continue
        const result = toolResults[toolCall.id]
        if (result) {
          finalMessages.push(result.toolMessage)
          emittedToolResultIds.add(toolCall.id)
          if (result.imageMessage) {
            finalMessages.push(result.imageMessage)
          }
        }
      }
    }
  }

  return finalMessages
}
