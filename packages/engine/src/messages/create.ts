import { createHash, randomUUID } from 'crypto'
import type { UUID } from 'crypto'

import type {
  ContentBlock,
  ContentBlockParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'

import type { Tool, ToolResultMetadata } from '@kode/tool-interface/Tool'
import { createAnthropicUsage } from '@kode/protocol/anthropic'
import type {
  AssistantMessage,
  Message,
  ProgressMessage,
  UserMessage,
} from '../pipeline/types'

import { CANCEL_MESSAGE, NO_CONTENT_MESSAGE } from './constants'
import type { NormalizedMessage } from './normalize'

function stableUuidFromSeed(seed: string): UUID {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}` as UUID
}

function baseCreateAssistantMessage(
  content: ContentBlock[],
  extra?: Partial<AssistantMessage>,
): AssistantMessage {
  return {
    type: 'assistant',
    costUSD: 0,
    durationMs: 0,
    uuid: randomUUID(),
    message: {
      id: randomUUID(),
      model: '<synthetic>',
      role: 'assistant',
      stop_reason: 'stop_sequence',
      stop_sequence: '',
      type: 'message',
      usage: createAnthropicUsage(),
      content,
    },
    ...extra,
  }
}

export function createAssistantMessage(content: string): AssistantMessage {
  return baseCreateAssistantMessage([
    {
      type: 'text' as const,
      text: content === '' ? NO_CONTENT_MESSAGE : content,
      citations: [],
    },
  ])
}

export function createAssistantAPIErrorMessage(
  content: string,
): AssistantMessage {
  return baseCreateAssistantMessage(
    [
      {
        type: 'text' as const,
        text: content === '' ? NO_CONTENT_MESSAGE : content,
        citations: [],
      },
    ],
    { isApiErrorMessage: true },
  )
}

export type FullToolUseResult = {
  data: unknown
  resultForAssistant: ToolResultBlockParam['content']
  metadata?: ToolResultMetadata
  newMessages?: Message[]
  contextModifier?: { modifyContext: (ctx: any) => any }
}

export function createUserMessage(
  content: string | ContentBlockParam[],
  toolUseResult?: FullToolUseResult,
): UserMessage {
  const m: UserMessage = {
    type: 'user',
    message: {
      role: 'user',
      content,
    },
    uuid: randomUUID(),
    toolUseResult,
  }
  return m
}

export function createProgressMessage(
  toolUseID: string,
  siblingToolUseIDs: Set<string>,
  content: AssistantMessage,
  normalizedMessages: NormalizedMessage[],
  tools: Tool[],
): ProgressMessage {
  return {
    type: 'progress',
    content,
    normalizedMessages,
    siblingToolUseIDs,
    tools,
    toolUseID,
    uuid: stableUuidFromSeed(`progress:${toolUseID}`),
  }
}

export function createToolResultStopMessage(
  toolUseID: string,
): ToolResultBlockParam {
  return {
    type: 'tool_result',
    content: CANCEL_MESSAGE,
    is_error: true,
    tool_use_id: toolUseID,
  }
}
