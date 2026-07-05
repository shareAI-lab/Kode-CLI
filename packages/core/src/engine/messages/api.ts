import { last } from 'lodash-es'

import type {
  ContentBlockParam,
  Message as APIMessage,
} from '@anthropic-ai/sdk/resources/index.mjs'

import { NO_CONTENT_MESSAGE } from '#core/ai/constants'
import type { AssistantMessage, Message, UserMessage } from '#core/query'

export function normalizeMessagesForAPI(
  messages: Message[],
): (UserMessage | AssistantMessage)[] {
  function isApiErrorMessage(message: Message): boolean {
    return message.type === 'assistant' && message.isApiErrorMessage === true
  }

  function isSyntheticMetaMessage(message: Message): boolean {
    return (
      message.type === 'assistant' &&
      message.isMeta === true &&
      message.message.model === '<synthetic>'
    )
  }

  function normalizeUserContent(
    content: UserMessage['message']['content'],
  ): ContentBlockParam[] {
    if (typeof content === 'string') {
      return [{ type: 'text', text: content }]
    }
    return content
  }

  function toolResultsFirst(content: ContentBlockParam[]): ContentBlockParam[] {
    const toolResults: ContentBlockParam[] = []
    const rest: ContentBlockParam[] = []
    for (const block of content) {
      if (block.type === 'tool_result') {
        toolResults.push(block)
      } else {
        rest.push(block)
      }
    }
    return [...toolResults, ...rest]
  }

  function mergeUserMessages(
    base: UserMessage,
    next: UserMessage,
  ): UserMessage {
    const baseBlocks = normalizeUserContent(base.message.content)
    const nextBlocks = normalizeUserContent(next.message.content)
    return {
      ...base,
      message: {
        ...base.message,
        content: toolResultsFirst([...baseBlocks, ...nextBlocks]),
      },
    }
  }

  function isUserToolResultMessage(message: Message): message is UserMessage {
    if (message.type !== 'user') return false
    if (!Array.isArray(message.message.content)) return false
    return message.message.content.some(block => block.type === 'tool_result')
  }

  const result: (UserMessage | AssistantMessage)[] = []
  for (const message of messages) {
    if (message.type === 'progress') continue
    if (isApiErrorMessage(message)) continue
    if (isSyntheticMetaMessage(message)) continue

    switch (message.type) {
      case 'user': {
        const prev = last(result)
        if (prev?.type === 'user') {
          result[result.indexOf(prev)] = mergeUserMessages(prev, message)
        } else {
          result.push(message)
        }
        break
      }
      case 'assistant': {
        let merged = false
        for (let i = result.length - 1; i >= 0; i--) {
          const prev = result[i]
          if (prev.type !== 'assistant' && !isUserToolResultMessage(prev)) {
            break
          }
          if (prev.type === 'assistant') {
            if (prev.message.id === message.message.id) {
              result[i] = {
                ...prev,
                message: {
                  ...prev.message,
                  content: [
                    ...(Array.isArray(prev.message.content)
                      ? prev.message.content
                      : []),
                    ...(Array.isArray(message.message.content)
                      ? message.message.content
                      : []),
                  ],
                },
              }
              merged = true
            }
            break
          }
        }
        if (!merged) {
          result.push(message)
        }
        break
      }
    }
  }

  return result
}

export function normalizeContentFromAPI(
  content: APIMessage['content'],
): APIMessage['content'] {
  const filteredContent = content.filter(
    _ => _.type !== 'text' || _.text.trim().length > 0,
  )

  if (filteredContent.length === 0) {
    return [{ type: 'text', text: NO_CONTENT_MESSAGE, citations: [] }]
  }

  return filteredContent
}

export function isEmptyMessageText(text: string): boolean {
  return (
    stripSystemMessages(text).trim() === '' ||
    text.trim() === NO_CONTENT_MESSAGE
  )
}

const STRIPPED_TAGS = [
  'commit_analysis',
  'context',
  'function_analysis',
  'pr_analysis',
]

export function stripSystemMessages(content: string): string {
  const regex = new RegExp(
    `<(${STRIPPED_TAGS.join('|')})>.*?</\\\\1>\\n?`,
    'gs',
  )
  return content.replace(regex, '').trim()
}

export function getLastAssistantMessageId(
  messages: Message[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message && message.type === 'assistant') {
      return message.message.id
    }
  }
  return undefined
}
