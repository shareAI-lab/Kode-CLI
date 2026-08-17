import { randomUUID } from 'node:crypto'

import type { AssistantMessage, UserMessage } from '#core/query'
import type { ModelProfile } from '#core/utils/config'
import type { Tool, ToolUseContext } from '#core/tooling/Tool'
import { createAnthropicUsage } from '#core/utils/anthropic'
import { emitAssistantStreamUpdate } from '@kode/tool-interface/assistantStreamUpdate'

import { GrokAcpClient } from './externalRuntime/grokAcp'
import {
  buildExternalRuntimePrompt,
  buildExternalRuntimeSystemPrompt,
  getExternalModelId,
} from './externalRuntime/utils'

type Options = {
  modelProfile: ModelProfile
  toolUseContext?: ToolUseContext
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getSessionId(result: unknown): string {
  if (!isRecord(result) || typeof result.sessionId !== 'string') {
    throw new Error('Grok ACP did not return a session ID')
  }
  return result.sessionId
}

function getTextUpdate(params: unknown): string | null {
  if (!isRecord(params) || params.sessionUpdate !== 'agent_message_chunk')
    return null
  const content = params.content
  return isRecord(content) && typeof content.text === 'string'
    ? content.text
    : null
}

async function waitForStreamToSettle(
  getText: () => string,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + 10 * 60 * 1000
  let lastLength = -1
  let stableChecks = 0

  while (stableChecks < 2) {
    if (signal.aborted) throw new Error('Grok request was cancelled')
    if (Date.now() >= deadline) {
      throw new Error('Grok Build timed out while waiting for assistant text')
    }
    await new Promise(resolve => setTimeout(resolve, 150))
    const currentLength = getText().length
    if (currentLength === lastLength) stableChecks += 1
    else {
      lastLength = currentLength
      stableChecks = 0
    }
  }
}

/**
 * Runs inference through Grok Build's official ACP endpoint after its CLI has
 * authenticated. No XAI_API_KEY is copied to, or persisted by, Kode.
 */
export async function queryGrokBuild(
  messages: (UserMessage | AssistantMessage)[],
  systemPrompt: string[],
  _maxThinkingTokens: number,
  _tools: Tool[],
  signal: AbortSignal,
  options: Options,
): Promise<AssistantMessage> {
  const startedAt = Date.now()
  let sessionId = ''
  let text = ''
  let emittedStart = false
  const streamOptions = {
    onAssistantStreamUpdate:
      options.toolUseContext?.options?.onAssistantStreamUpdate,
    agentId: options.toolUseContext?.agentId,
    requestId: options.toolUseContext?.requestId,
  }
  const client = new GrokAcpClient({
    onNotification(method, params) {
      if (
        method !== 'session/update' ||
        !isRecord(params) ||
        params.sessionId !== sessionId
      ) {
        return
      }
      const delta = getTextUpdate(params.update)
      if (!delta) return
      text += delta
      if (!emittedStart) {
        emittedStart = true
        emitAssistantStreamUpdate(streamOptions, { type: 'start' })
      }
      emitAssistantStreamUpdate(streamOptions, { type: 'text_delta', delta })
    },
    onServerRequest(id, method) {
      client.respondError(
        id,
        `Kode has not enabled the Grok ACP ${method} tool bridge for OAuth model profiles.`,
      )
    },
  })
  const abort = () => {
    if (sessionId) client.notify('session/cancel', { sessionId })
    void client.stop()
  }

  try {
    if (signal.aborted) throw new Error('Grok request was cancelled')
    signal.addEventListener('abort', abort, { once: true })
    await client.start()
    const created = await client.request('session/new', {
      cwd: process.cwd(),
      mcpServers: [],
    })
    sessionId = getSessionId(created)
    await client.request('session/set_model', {
      sessionId,
      modelId: getExternalModelId(options.modelProfile),
    })
    const prompt = [
      '[Kode system instructions]',
      buildExternalRuntimeSystemPrompt(systemPrompt),
      '[/Kode system instructions]',
      '',
      '[Conversation]',
      buildExternalRuntimePrompt(messages),
      '[/Conversation]',
    ].join('\n')
    await client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: prompt }],
    })
    await waitForStreamToSettle(() => text, signal)
    if (!text) throw new Error('Grok Build returned no assistant text')

    return {
      type: 'assistant',
      uuid: randomUUID(),
      costUSD: 0,
      durationMs: Date.now() - startedAt,
      message: {
        id: randomUUID(),
        model: getExternalModelId(options.modelProfile),
        role: 'assistant',
        type: 'message',
        content: [{ type: 'text', text, citations: [] }],
        usage: createAnthropicUsage({
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        }),
        stop_reason: 'end_turn',
        stop_sequence: null,
      },
    }
  } finally {
    signal.removeEventListener('abort', abort)
    await client.stop()
  }
}
