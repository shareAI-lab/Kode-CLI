/**
 * Structural conversation message shapes used by @kode/ai LLM transport.
 * Hosts may use richer types; these are the fields the AI package reads/writes.
 */

import type { UUID } from 'crypto'
import type { AnthropicUsage } from '@kode/protocol/anthropic'

export type AiUserMessage = {
  type: 'user'
  uuid?: UUID
  message: {
    role: 'user' | 'assistant'
    content: unknown
  }
  [key: string]: unknown
}

export type AiAssistantApiMessage = {
  id: string
  model: string
  role: 'assistant'
  type: 'message'
  content: any[]
  usage: AnthropicUsage
  stop_reason?: string | null
  stop_sequence?: string | null
  [key: string]: unknown
}

export type AiAssistantMessage = {
  type: 'assistant'
  costUSD: number
  durationMs: number
  uuid: UUID
  message: AiAssistantApiMessage
  isApiErrorMessage?: boolean
  isMeta?: boolean
  requestId?: string
  responseId?: string
  [key: string]: unknown
}

export type UnifiedRequestParams = {
  messages: any[]
  systemPrompt: string[]
  tools?: any[]
  maxTokens: number
  stream?: boolean
  previousResponseId?: string
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'
  reasoning?: {
    enable: boolean
    effort: 'low' | 'medium' | 'high' | 'none' | 'minimal'
    summary: 'auto' | 'concise' | 'detailed' | 'none'
  }
  verbosity?: 'low' | 'medium' | 'high'
  temperature?: number
  allowedTools?: string[]
  stopSequences?: string[]
}
