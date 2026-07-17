import { randomUUID } from 'crypto'
import type { UUID } from 'crypto'

import { createAnthropicUsage } from '@kode/protocol/anthropic'
import type { AiAssistantMessage as AssistantMessage } from './messageTypes'

import {
  API_ERROR_MESSAGE_PREFIX,
  CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE,
  INVALID_API_KEY_ERROR_MESSAGE,
  PROMPT_TOO_LONG_ERROR_MESSAGE,
} from './constants'
import { debug as debugLogger } from './debug'

function createAssistantAPIErrorMessage(content: string): AssistantMessage {
  return {
    type: 'assistant',
    costUSD: 0,
    durationMs: 0,
    uuid: randomUUID() as UUID,
    isApiErrorMessage: true,
    message: {
      id: randomUUID(),
      model: '<synthetic>',
      role: 'assistant',
      stop_reason: 'stop_sequence',
      stop_sequence: '',
      type: 'message',
      usage: createAnthropicUsage(),
      content: [
        {
          type: 'text' as const,
          text: content || '(no content)',
          citations: [],
        },
      ],
    },
  }
}

export function getAssistantMessageFromError(error: unknown): AssistantMessage {
  if (error instanceof Error && error.message.includes('prompt is too long')) {
    return createAssistantAPIErrorMessage(PROMPT_TOO_LONG_ERROR_MESSAGE)
  }
  if (
    error instanceof Error &&
    error.message.includes('Your credit balance is too low')
  ) {
    return createAssistantAPIErrorMessage(CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE)
  }
  if (
    error instanceof Error &&
    error.message.toLowerCase().includes('x-api-key')
  ) {
    return createAssistantAPIErrorMessage(INVALID_API_KEY_ERROR_MESSAGE)
  }
  if (error instanceof Error) {
    if (process.env.NODE_ENV === 'development') {
      debugLogger.error('OPENAI_API_ERROR', {
        message: error.message,
        stack: error.stack,
      })
    }
    return createAssistantAPIErrorMessage(
      `${API_ERROR_MESSAGE_PREFIX}: ${error.message}`,
    )
  }
  return createAssistantAPIErrorMessage(API_ERROR_MESSAGE_PREFIX)
}
