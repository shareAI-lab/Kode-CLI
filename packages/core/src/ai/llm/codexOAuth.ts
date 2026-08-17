import { randomUUID } from 'node:crypto'

import type { AssistantMessage, UserMessage } from '#core/query'
import type { ModelProfile } from '#core/utils/config'
import {
  getToolDescription,
  type Tool,
  type ToolUseContext,
} from '#core/tooling/Tool'
import { createAnthropicUsage } from '#core/utils/anthropic'
import { emitAssistantStreamUpdate } from '@kode/tool-interface/assistantStreamUpdate'
import { toInputJsonSchema } from '@kode/tool-interface/jsonSchema'

import {
  CodexAppServerClient,
  CodexAppServerTimeoutError,
} from './externalRuntime/codexAppServer'
import { formatExternalRuntimeDiagnostic } from './externalRuntime/diagnostics'
import {
  buildExternalRuntimePrompt,
  buildExternalRuntimeSystemPrompt,
  getExternalModelId,
  getFinalTextFromExternalItems,
} from './externalRuntime/utils'

type CodexAppServerHandlers = {
  onNotification(method: string, params: unknown): void
  onServerRequest(id: number | string, method: string, params: unknown): void
}

type CodexAppServerClientLike = Pick<
  CodexAppServerClient,
  'start' | 'stop' | 'request' | 'respond' | 'respondError'
>

type Options = {
  modelProfile: ModelProfile
  toolUseContext?: ToolUseContext
  __testClientFactory?: (
    handlers: CodexAppServerHandlers,
  ) => CodexAppServerClientLike
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getThreadId(result: unknown): string {
  if (
    !isRecord(result) ||
    !isRecord(result.thread) ||
    typeof result.thread.id !== 'string'
  ) {
    throw new Error('Codex app-server did not return a thread ID')
  }
  return result.thread.id
}

function getTurnId(result: unknown): string {
  if (
    !isRecord(result) ||
    !isRecord(result.turn) ||
    typeof result.turn.id !== 'string'
  ) {
    throw new Error('Codex app-server did not return a turn ID')
  }
  return result.turn.id
}

type DynamicToolCallParams = {
  callId: string
  threadId: string
  turnId: string
  tool: string
  namespace?: string | null
  arguments: unknown
}

export class CodexAppServerTurnError extends Error {
  constructor(message: string) {
    super(`Codex app-server turn failed: ${message}`)
    this.name = 'CodexAppServerTurnError'
  }
}

function isExternalRuntimeToolEligible(tool: Tool): boolean {
  try {
    return tool.requiresUserInteraction?.() !== true
  } catch {
    return false
  }
}

function getDynamicToolDescription(tool: Tool): string {
  return getToolDescription(tool)
}

function getDynamicToolInputSchema(tool: Tool): Record<string, unknown> {
  return tool.inputJSONSchema ?? toInputJsonSchema(tool.inputSchema)
}

function getDynamicTools(
  tools: Tool[],
  enabled: boolean,
): Array<Record<string, unknown>> | undefined {
  if (!enabled || tools.length === 0) return undefined
  const eligibleTools = tools.filter(isExternalRuntimeToolEligible)
  if (eligibleTools.length === 0) return undefined
  return eligibleTools.map(tool => ({
    type: 'function',
    name: tool.name,
    description: getDynamicToolDescription(tool),
    inputSchema: getDynamicToolInputSchema(tool),
  }))
}

function parseDynamicToolCallParams(
  value: unknown,
): DynamicToolCallParams | null {
  if (
    !isRecord(value) ||
    typeof value.callId !== 'string' ||
    typeof value.threadId !== 'string' ||
    typeof value.turnId !== 'string' ||
    typeof value.tool !== 'string' ||
    (value.namespace !== undefined &&
      value.namespace !== null &&
      typeof value.namespace !== 'string')
  ) {
    return null
  }

  return {
    callId: value.callId,
    threadId: value.threadId,
    turnId: value.turnId,
    tool: value.tool,
    namespace:
      typeof value.namespace === 'string' || value.namespace === null
        ? value.namespace
        : undefined,
    arguments: value.arguments,
  }
}

function asToolInput(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function getFailedTurnError(value: unknown): CodexAppServerTurnError | null {
  if (!isRecord(value) || value.status !== 'failed') return null
  const message = isRecord(value.error) ? value.error.message : undefined
  return new CodexAppServerTurnError(
    typeof message === 'string' && message.trim()
      ? formatExternalRuntimeDiagnostic(message)
      : 'The runtime did not provide a failure reason.',
  )
}

function dynamicToolResponse(success: boolean, content: string) {
  return {
    success,
    contentItems: [{ type: 'inputText', text: content }],
  }
}

/**
 * Reuses the authenticated Codex CLI for actual inference. Kode stores only a
 * provider profile; the OAuth refresh token is never read or copied here.
 */
export async function queryCodexOAuth(
  messages: (UserMessage | AssistantMessage)[],
  systemPrompt: string[],
  _maxThinkingTokens: number,
  _tools: Tool[],
  signal: AbortSignal,
  options: Options,
): Promise<AssistantMessage> {
  const startedAt = Date.now()
  let streamedText = ''
  let emittedStart = false
  let threadId = ''
  let turnId = ''
  let completedTurn: unknown

  const streamOptions = {
    onAssistantStreamUpdate:
      options.toolUseContext?.options?.onAssistantStreamUpdate,
    agentId: options.toolUseContext?.agentId,
    requestId: options.toolUseContext?.requestId,
  }
  let client: CodexAppServerClientLike
  const handleDynamicToolCall = async (
    id: number | string,
    params: unknown,
  ): Promise<void> => {
    const call = parseDynamicToolCallParams(params)
    const executeTool = options.toolUseContext?.options?.executeExternalToolCall
    if (
      !call ||
      call.threadId !== threadId ||
      call.turnId !== turnId ||
      call.namespace
    ) {
      client.respond(
        id,
        dynamicToolResponse(
          false,
          'Kode rejected an invalid dynamic tool call.',
        ),
      )
      return
    }
    const input = asToolInput(call.arguments)
    if (!input || !executeTool) {
      client.respond(
        id,
        dynamicToolResponse(
          false,
          'Kode cannot execute this dynamic tool call in the current turn.',
        ),
      )
      return
    }

    try {
      const result = await executeTool({
        toolUseId: call.callId,
        toolName: call.tool,
        input,
      })
      client.respond(id, dynamicToolResponse(result.success, result.content))
    } catch (error) {
      client.respond(
        id,
        dynamicToolResponse(
          false,
          `Kode tool bridge failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      )
    }
  }

  const handlers: CodexAppServerHandlers = {
    onNotification(method, params) {
      if (method === 'item/agentMessage/delta' && isRecord(params)) {
        if (params.threadId !== threadId || params.turnId !== turnId) return
        const delta = params.delta
        if (typeof delta !== 'string' || delta.length === 0) return
        streamedText += delta
        if (!emittedStart) {
          emittedStart = true
          emitAssistantStreamUpdate(streamOptions, { type: 'start' })
        }
        emitAssistantStreamUpdate(streamOptions, { type: 'text_delta', delta })
      }
      if (method === 'turn/completed' && isRecord(params)) {
        if (params.threadId === threadId) completedTurn = params.turn
      }
    },
    onServerRequest(id, method, params) {
      if (method === 'item/tool/call') {
        void handleDynamicToolCall(id, params)
        return
      }
      if (
        method === 'item/commandExecution/requestApproval' ||
        method === 'item/fileChange/requestApproval'
      ) {
        client.respond(id, { decision: 'decline' })
        return
      }
      // A Kode permission bridge has not been implemented for the remaining
      // experimental server callbacks, so refuse them instead of bypassing Kode.
      client.respondError(
        id,
        'Kode has not enabled this Codex tool bridge for OAuth model profiles.',
      )
    },
  }
  client =
    options.__testClientFactory?.(handlers) ??
    new CodexAppServerClient(handlers, { experimentalApi: true })

  const abort = () => {
    if (threadId && turnId) {
      void client
        .request('turn/interrupt', { threadId, turnId })
        .catch(() => {})
    }
    void client.stop()
  }

  try {
    if (signal.aborted) throw new Error('Codex request was cancelled')
    signal.addEventListener('abort', abort, { once: true })
    await client.start()
    const system = buildExternalRuntimeSystemPrompt(systemPrompt)
    const thread = await client.request('thread/start', {
      cwd: process.cwd(),
      ephemeral: true,
      model: getExternalModelId(options.modelProfile),
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      dynamicTools: getDynamicTools(
        _tools,
        typeof options.toolUseContext?.options?.executeExternalToolCall ===
          'function',
      ),
      baseInstructions: `${system}\n\nKode owns tool permissions. Use the registered Kode dynamic tools for workspace inspection and actions; Kode will apply its normal permission policy. Do not use native Codex command or file tools.`,
    })
    threadId = getThreadId(thread)
    const turn = await client.request('turn/start', {
      threadId,
      model: getExternalModelId(options.modelProfile),
      effort: options.modelProfile.reasoningEffort ?? null,
      input: [{ type: 'text', text: buildExternalRuntimePrompt(messages) }],
    })
    turnId = getTurnId(turn)

    const deadline = Date.now() + 10 * 60 * 1000
    while (!completedTurn) {
      if (signal.aborted) throw new Error('Codex request was cancelled')
      if (Date.now() >= deadline) {
        throw new CodexAppServerTimeoutError('waiting for the turn')
      }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    const completed = completedTurn
    if (signal.aborted) throw new Error('Codex request was cancelled')
    const failedTurnError = getFailedTurnError(completed)
    if (failedTurnError) throw failedTurnError
    const text =
      getFinalTextFromExternalItems(
        isRecord(completed) && Array.isArray(completed.items)
          ? completed.items
          : [],
      ) || streamedText
    if (!text) throw new Error('Codex returned no assistant text')

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
