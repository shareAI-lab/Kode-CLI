/**
 * MCP Sampling capability implementation.
 *
 * When an MCP server sends a `sampling/createMessage` request, this module
 * handles it by routing through the local LLM infrastructure (queryLLM).
 *
 * The MCP spec notes: "The client has full discretion over which model to
 * select. The client should also inform the user before beginning sampling,
 * to allow them to inspect the request (human in the loop)."
 */
import { randomUUID } from 'node:crypto'
import type { UUID } from 'node:crypto'

import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { CreateMessageRequestSchema } from '@modelcontextprotocol/sdk/types.js'

import type { MessageParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { UserMessage, AssistantMessage } from '#core/query'
import { queryLLM } from '#core/ai/llm'
import { getModelManager } from '#core/utils/model'
import { logMCPError } from '#core/utils/log'
import { createAnthropicUsage } from '@kode/protocol/anthropic'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SamplingMessage = {
  role: 'user' | 'assistant'
  content:
    | SamplingContentBlock
    | SamplingContentBlock[]
}

type SamplingContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: unknown; isError?: boolean }

type CreateMessageParams = {
  messages: SamplingMessage[]
  modelPreferences?: {
    hints?: Array<{ name?: string }>
    costPriority?: number
    speedPriority?: number
    intelligencePriority?: number
  }
  systemPrompt?: string
  includeContext?: 'none' | 'thisServer' | 'allServers'
  temperature?: number
  maxTokens: number
  stopSequences?: string[]
  metadata?: Record<string, unknown>
  tools?: Array<{
    name: string
    description?: string
    inputSchema: Record<string, unknown>
  }>
  toolChoice?: { mode: string } | { mode: 'tool'; name: string }
}

type CreateMessageResult = {
  model: string
  stopReason?: string
  role: 'assistant'
  content: { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Model pointer used for sampling requests. Defaults to "quick" for fast responses. */
const SAMPLING_MODEL_POINTER = 'quick'

let samplingEnabled = true
let samplingEnabledOverrideForTests: boolean | null = null

const samplingClients = new Set<Client>()

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function isMcpSamplingEnabled(): boolean {
  if (
    process.env.NODE_ENV === 'test' &&
    samplingEnabledOverrideForTests !== null
  ) {
    return samplingEnabledOverrideForTests
  }
  return samplingEnabled
}

export function setMcpSamplingEnabled(enabled: boolean): void {
  samplingEnabled = enabled
}

/**
 * Register the sampling/createMessage request handler on the given MCP client.
 * This should be called during client initialization (alongside roots).
 */
export function registerMcpSamplingHandler(client: Client): void {
  if (!isMcpSamplingEnabled()) return

  client.setRequestHandler(
    CreateMessageRequestSchema,
    async (request, _extra) => {
      const params = request.params as CreateMessageParams
      return await handleCreateMessage(params)
    },
  )

  samplingClients.add(client)
}

/**
 * Unregister the sampling request handler from the given MCP client.
 */
export function unregisterMcpSamplingHandler(client: Client): void {
  const wasRegistered = samplingClients.delete(client)
  if (wasRegistered) {
    const clientWithRemove = client as Client & {
      removeRequestHandler?: (method: string) => void
    }
    clientWithRemove.removeRequestHandler?.('sampling/createMessage')
  }
}

// ---------------------------------------------------------------------------
// Core Handler
// ---------------------------------------------------------------------------

async function handleCreateMessage(
  params: CreateMessageParams,
): Promise<CreateMessageResult> {
  const { messages, systemPrompt, temperature, maxTokens, stopSequences } =
    params

  // Convert MCP sampling messages to internal message format
  const internalMessages = convertSamplingMessages(messages)

  // Resolve system prompt
  const system = systemPrompt ? [systemPrompt] : []

  // Resolve model - we use the quick model pointer for sampling by default,
  // but respect modelPreferences hints if a matching model is configured.
  const modelPointer = resolveModelFromPreferences(params.modelPreferences)

  // Create an abort controller for this sampling request
  const abortController = new AbortController()

  try {
    const result = await queryLLM(
      internalMessages,
      system,
      0, // no thinking tokens for sampling
      [], // no tools for now (basic sampling)
      abortController.signal,
      {
        safeMode: false,
        model: modelPointer,
        prependCLISysprompt: false,
        temperature: temperature ?? undefined,
        maxTokens,
        stopSequences,
      },
    )

    return convertToSamplingResult(result)
  } catch (error) {
    logMCPError(
      'sampling',
      `Failed to handle createMessage: ${error instanceof Error ? error.message : String(error)}`,
    )
    throw error
  }
}

// ---------------------------------------------------------------------------
// Message Conversion: MCP Sampling → Internal Format
// ---------------------------------------------------------------------------

function convertSamplingMessages(
  messages: SamplingMessage[],
): (UserMessage | AssistantMessage)[] {
  const result: (UserMessage | AssistantMessage)[] = []

  for (const msg of messages) {
    const contentBlocks = normalizeContent(msg.content)

    if (msg.role === 'user') {
      result.push(convertToUserMessage(contentBlocks))
    } else if (msg.role === 'assistant') {
      result.push(convertToAssistantMessage(contentBlocks))
    }
  }

  return result
}

function normalizeContent(
  content: SamplingContentBlock | SamplingContentBlock[],
): SamplingContentBlock[] {
  return Array.isArray(content) ? content : [content]
}

function convertToUserMessage(
  blocks: SamplingContentBlock[],
): UserMessage {
  const anthropicContent: MessageParam['content'] = blocks.map(block => {
    switch (block.type) {
      case 'text':
        return { type: 'text' as const, text: block.text }
      case 'image':
        return {
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: block.mimeType as
              | 'image/jpeg'
              | 'image/png'
              | 'image/gif'
              | 'image/webp',
            data: block.data,
          },
        }
      default:
        // For unsupported block types, convert to text representation
        return { type: 'text' as const, text: JSON.stringify(block) }
    }
  })

  return {
    message: { role: 'user', content: anthropicContent },
    type: 'user',
    uuid: randomUUID() as UUID,
  }
}

function convertToAssistantMessage(
  blocks: SamplingContentBlock[],
): AssistantMessage {
  const content = blocks.map(block => {
    switch (block.type) {
      case 'text':
        return { type: 'text' as const, text: block.text }
      default:
        return { type: 'text' as const, text: JSON.stringify(block) }
    }
  })

  return {
    costUSD: 0,
    durationMs: 0,
    message: {
      id: `msg_sampling_${randomUUID()}`,
      model: 'unknown',
      role: 'assistant',
      type: 'message',
      content,
      usage: createAnthropicUsage(),
      stop_reason: null,
    },
    type: 'assistant',
    uuid: randomUUID() as UUID,
  }
}

// ---------------------------------------------------------------------------
// Result Conversion: Internal Format → MCP Sampling Result
// ---------------------------------------------------------------------------

function convertToSamplingResult(
  assistantMessage: AssistantMessage,
): CreateMessageResult {
  const model = assistantMessage.message.model || 'unknown'
  const stopReason = mapStopReason(assistantMessage.message.stop_reason)

  // Extract text content from the response
  const textContent = extractTextContent(assistantMessage.message.content)

  return {
    model,
    stopReason,
    role: 'assistant',
    content: { type: 'text', text: textContent },
  }
}

function mapStopReason(
  stopReason: string | null | undefined,
): string | undefined {
  if (!stopReason) return undefined

  switch (stopReason) {
    case 'end_turn':
      return 'endTurn'
    case 'stop_sequence':
      return 'stopSequence'
    case 'max_tokens':
      return 'maxTokens'
    case 'tool_use':
      return 'toolUse'
    default:
      return stopReason
  }
}

function extractTextContent(content: any[]): string {
  if (!Array.isArray(content)) return ''

  const textParts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text') {
      textParts.push(block.text || '')
    }
  }

  return textParts.join('\n')
}

// ---------------------------------------------------------------------------
// Model Preferences Resolution
// ---------------------------------------------------------------------------

function resolveModelFromPreferences(
  preferences?: CreateMessageParams['modelPreferences'],
): string {
  if (!preferences?.hints?.length) return SAMPLING_MODEL_POINTER

  // Try to match model hints against configured models
  const modelManager = getModelManager()

  for (const hint of preferences.hints) {
    if (!hint.name) continue

    // Check if the hint matches any configured model name directly
    const resolved = modelManager.resolveModel(hint.name)
    if (resolved) return hint.name
  }

  // If speed is prioritized, use "quick" model
  if (
    preferences.speedPriority &&
    preferences.speedPriority > (preferences.intelligencePriority ?? 0)
  ) {
    return 'quick'
  }

  // If intelligence is prioritized, use "main" model
  if (
    preferences.intelligencePriority &&
    preferences.intelligencePriority > (preferences.speedPriority ?? 0)
  ) {
    return 'main'
  }

  return SAMPLING_MODEL_POINTER
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function __setMcpSamplingEnabledForTests(
  value: boolean | null,
): void {
  samplingEnabledOverrideForTests = value
}

export function __resetMcpSamplingForTests(): void {
  samplingEnabledOverrideForTests = null
  samplingClients.clear()
}
