import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { CopilotClient } from '@github/copilot-sdk'
import type { AssistantMessage, UserMessage } from '#core/query'
import type { ModelProfile } from '#core/utils/config'
import type { Tool, ToolUseContext } from '#core/tooling/Tool'
import { createAnthropicUsage } from '#core/utils/anthropic'
import { emitAssistantStreamUpdate } from '@kode/tool-interface/assistantStreamUpdate'

import {
  buildExternalRuntimePrompt,
  buildExternalRuntimeSystemPrompt,
  getExternalModelId,
} from './externalRuntime/utils'

type Options = {
  modelProfile: ModelProfile
  toolUseContext?: ToolUseContext
}

function checkForAbort(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('GitHub Copilot request was cancelled')
}

/**
 * Calls the official Copilot runtime with its own credential resolution. Kode
 * deliberately gives the runtime an empty tool allow-list: forwarding Kode
 * tools requires a full permission bridge, and allowing Copilot's ambient
 * shell/filesystem tools would bypass Kode's reviewed permission boundary.
 */
export async function queryGitHubCopilot(
  messages: (UserMessage | AssistantMessage)[],
  systemPrompt: string[],
  _maxThinkingTokens: number,
  _tools: Tool[],
  signal: AbortSignal,
  options: Options,
): Promise<AssistantMessage> {
  const start = Date.now()
  const client = new CopilotClient({
    mode: 'empty',
    // Reuse the official Copilot CLI home without opening or copying its
    // credentials. The SDK runtime performs its normal secure lookup itself.
    baseDirectory: join(homedir(), '.copilot'),
  })
  let session: Awaited<ReturnType<CopilotClient['createSession']>> | undefined
  let streamedText = ''
  let streamedReasoning = ''
  let emittedStart = false

  try {
    checkForAbort(signal)
    await client.start()
    const authStatus = await client.getAuthStatus()
    if (!authStatus.isAuthenticated) {
      throw new Error(
        'GitHub Copilot is not authenticated. Run /login, select GitHub Copilot, and complete the official OAuth sign-in.',
      )
    }

    session = await client.createSession({
      clientName: 'kode-cli',
      model: getExternalModelId(options.modelProfile),
      reasoningEffort: options.modelProfile.reasoningEffort as never,
      availableTools: [],
      excludedTools: ['builtin:*', 'mcp:*', 'custom:*'],
      systemMessage: {
        mode: 'append',
        content: buildExternalRuntimeSystemPrompt(systemPrompt),
      },
      onPermissionRequest: () => ({
        kind: 'reject',
        feedback:
          'Kode does not forward Copilot runtime tools without its own permission bridge.',
      }),
    })

    const onAssistantStreamUpdate =
      options.toolUseContext?.options?.onAssistantStreamUpdate
    const streamOptions = {
      onAssistantStreamUpdate,
      agentId: options.toolUseContext?.agentId,
      requestId: options.toolUseContext?.requestId,
    }
    const unsubscribeStart = session.on('assistant.message_start', () => {
      if (emittedStart) return
      emittedStart = true
      emitAssistantStreamUpdate(streamOptions, { type: 'start' })
    })
    const unsubscribeText = session.on('assistant.message_delta', event => {
      const delta = event.data.deltaContent
      if (!delta) return
      streamedText += delta
      if (!emittedStart) {
        emittedStart = true
        emitAssistantStreamUpdate(streamOptions, { type: 'start' })
      }
      emitAssistantStreamUpdate(streamOptions, { type: 'text_delta', delta })
    })
    const unsubscribeReasoning = session.on(
      'assistant.reasoning_delta',
      event => {
        const delta = event.data.deltaContent
        if (!delta) return
        streamedReasoning += delta
        if (options.toolUseContext?.options?.thinkingMode !== 'disabled') {
          emitAssistantStreamUpdate(streamOptions, {
            type: 'thinking_delta',
            delta,
          })
        }
      },
    )
    const abort = () => {
      void session?.abort().catch(() => {})
    }
    signal.addEventListener('abort', abort, { once: true })

    try {
      const response = await session.sendAndWait({
        prompt: buildExternalRuntimePrompt(messages),
      })
      checkForAbort(signal)
      const text = response?.data.content || streamedText
      if (!text) {
        throw new Error('GitHub Copilot returned no assistant text')
      }
      const reasoning = response?.data.reasoningText || streamedReasoning
      const content: AssistantMessage['message']['content'] = [
        ...(reasoning &&
        options.toolUseContext?.options?.thinkingMode !== 'disabled'
          ? [{ type: 'thinking', thinking: reasoning, signature: '' }]
          : []),
        { type: 'text', text, citations: [] },
      ]
      return {
        type: 'assistant',
        uuid: randomUUID(),
        costUSD: 0,
        durationMs: Date.now() - start,
        responseId: response?.data.apiCallId,
        message: {
          id: response?.data.messageId || randomUUID(),
          model:
            response?.data.model || getExternalModelId(options.modelProfile),
          role: 'assistant',
          type: 'message',
          content,
          usage: createAnthropicUsage({
            input_tokens: 0,
            output_tokens: response?.data.outputTokens ?? 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          }),
          stop_reason: 'end_turn',
          stop_sequence: null,
        },
      }
    } finally {
      signal.removeEventListener('abort', abort)
      unsubscribeStart()
      unsubscribeText()
      unsubscribeReasoning()
    }
  } finally {
    await session?.disconnect().catch(() => {})
    await client.stop().catch(() => {})
  }
}
