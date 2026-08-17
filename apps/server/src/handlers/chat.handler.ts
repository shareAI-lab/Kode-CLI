import type { Message as ApiMessage } from '@anthropic-ai/sdk/resources/index.mjs'
import { randomUUID } from 'node:crypto'
import type { AgentEvent } from '#protocol/agentEvent'

import {
  createUserMessage,
  createAssistantMessage,
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  REJECT_MESSAGE,
  REJECT_MESSAGE_WITH_FEEDBACK_PREFIX,
} from '@kode/core/utils/messages'
import { buildSystemPromptForSession, runTurn } from '@kode/engine'
import { getContext } from '@kode/context'
import type { AssistantMessage, Message } from '@kode/core/query'
import type { CanUseToolFn } from '@kode/core/permissions/canUseTool'
import { hasPermissionsToUseTool, savePermission } from '@kode/core/permissions'
import { getTotalCost } from '@kode/core/cost-tracker'
import {
  kodeMessageToSdkMessage,
  makeSdkResultMessage,
  makeSdkStreamEventMessage,
} from '#protocol/utils/kodeAgentStreamJson'
import { setSessionId } from '@kode/runtime'
import { setKodeAgentSessionForkInfo } from '#protocol/utils/kodeAgentSessionForkInfo'
import { appendSessionJsonlFromMessage } from '#protocol/utils/kodeAgentSessionLog'
import { setCwd, setOriginalCwd } from '@kode/core/utils/state'
import { grantReadPermissionForOriginalDir } from '@kode/core/utils/permissions/filesystem'
import {
  resolveToolDescription,
  type Tool,
  type ToolUseContext,
} from '@kode/core/tooling/Tool'
import type { DaemonSession } from '../ws/types'
import { waitForPermissionDecision } from '../ws/permissionRequests'
import type { WrappedClient } from '@kode/mcp/client'

type WsSend = (payload: AgentEvent) => void

export const DEFAULT_DAEMON_TURN_TIMEOUT_MS = 15 * 60 * 1000
const TURN_TIMEOUT_MESSAGE =
  'Request timed out before the model or a tool completed. The turn was cancelled; check the provider or tool and retry.'

type PermissionRequest = {
  type: 'permission_request'
  request_id: string
  tool_name: string
  tool_description: string
  input: Record<string, unknown>
}

function extractFirstAssistantText(message: ApiMessage): string | null {
  const blocks = Array.isArray(message.content) ? message.content : []
  for (const block of blocks) {
    if (block && typeof block === 'object' && block.type === 'text') {
      const maybeText = (block as { text?: unknown }).text
      if (typeof maybeText === 'string') return maybeText
    }
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function shouldForwardStreamEvent(event: unknown): boolean {
  return isRecord(event) && event.type === 'mcp_progress'
}

async function waitForDelayOrAbort(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (delayMs <= 0 || signal.aborted) return

  await new Promise<void>(resolve => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = () => {
      if (timer) clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    timer = setTimeout(finish, delayMs)
    signal.addEventListener('abort', finish, { once: true })
  })
}

export async function handleChatPrompt(args: {
  wsSend: WsSend
  session: DaemonSession
  prompt: string
  clientMessageUuid?: string
  echo: boolean
  echoDelayMs: number
  commands: unknown[]
  tools: Tool[]
  toolNames: string[]
  slashCommands: string[]
  mcpClients: WrappedClient[]
  persistSession?: boolean
  /** A detached schedule cannot answer permission prompts; deny instead. */
  shouldAvoidPermissionPrompts?: boolean
  /** Testable override; production uses a bounded 15 minute turn deadline. */
  requestTimeoutMs?: number
}): Promise<void> {
  const {
    wsSend,
    session,
    prompt,
    clientMessageUuid: requestedClientMessageUuid,
    echo,
    echoDelayMs,
    commands,
    tools,
    mcpClients,
  } = args
  const clientMessageUuid = requestedClientMessageUuid ?? crypto.randomUUID()

  const abortController = new AbortController()
  session.activeAbortController = abortController
  const requestTimeoutMs =
    args.requestTimeoutMs !== undefined &&
    Number.isFinite(args.requestTimeoutMs) &&
    args.requestTimeoutMs > 0
      ? Math.floor(args.requestTimeoutMs)
      : DEFAULT_DAEMON_TURN_TIMEOUT_MS
  let timedOut = false
  const timeoutId = setTimeout(() => {
    timedOut = true
    try {
      abortController.abort()
    } catch {
      // AbortController abort is best-effort.
    }
  }, requestTimeoutMs)

  const startedAt = Date.now()
  const costBefore = getTotalCost()
  let lastAssistant: AssistantMessage | null = null
  let userMessageRecorded = false
  let cancellationMessageRecorded = false
  let terminalResultSent = false
  const shouldPersistSession =
    args.persistSession ?? process.env.NODE_ENV !== 'test'

  const recordMessage = (
    message: Message,
    options: { persist?: boolean } = {},
  ) => {
    if (message.type === 'progress') return
    session.messages.push(message)
    session.updatedAt = new Date().toISOString()
    if (options.persist && shouldPersistSession) {
      appendSessionJsonlFromMessage({
        cwd: session.cwd,
        message,
        toolUseContext: { agentId: 'main' },
      })
    }
    if (message.type === 'assistant') {
      lastAssistant = message
      const text = extractFirstAssistantText(message.message as ApiMessage)
      if (
        text === INTERRUPT_MESSAGE ||
        text === INTERRUPT_MESSAGE_FOR_TOOL_USE
      ) {
        cancellationMessageRecorded = true
      }
    }
  }

  const recordAndSendMessage = (
    message: Message,
    options: { persist?: boolean } = {},
  ) => {
    recordMessage(message, options)
    const sdk = kodeMessageToSdkMessage(message, session.sessionId)
    if (sdk) wsSend(sdk)
  }

  const ensureCancellationMessage = () => {
    if (!userMessageRecorded || cancellationMessageRecorded) return
    recordAndSendMessage(createAssistantMessage(INTERRUPT_MESSAGE), {
      persist: true,
    })
  }

  const sendTerminalResult = (params: {
    result: string
    isError: boolean
    usage?: unknown
  }) => {
    if (terminalResultSent) return
    wsSend(
      makeSdkResultMessage({
        sessionId: session.sessionId,
        result: params.result,
        numTurns: userMessageRecorded ? 1 : 0,
        usage: params.usage,
        totalCostUsd: Math.max(0, getTotalCost() - costBefore),
        durationMs: Date.now() - startedAt,
        durationApiMs: 0,
        isError: params.isError,
      }),
    )
    terminalResultSent = true
  }

  const sendCancelledResult = () => {
    ensureCancellationMessage()
    sendTerminalResult({ result: INTERRUPT_MESSAGE, isError: true })
  }

  const sendTimedOutResult = () => {
    if (userMessageRecorded && !cancellationMessageRecorded) {
      recordAndSendMessage(createAssistantMessage(TURN_TIMEOUT_MESSAGE), {
        persist: true,
      })
    }
    sendTerminalResult({ result: TURN_TIMEOUT_MESSAGE, isError: true })
  }

  const sendAbortedResult = () => {
    if (timedOut) sendTimedOutResult()
    else sendCancelledResult()
  }

  try {
    setOriginalCwd(session.cwd)
    await setCwd(session.cwd)
    if (abortController.signal.aborted) {
      sendAbortedResult()
      return
    }
    grantReadPermissionForOriginalDir()

    setKodeAgentSessionForkInfo(
      session.forkedFromSessionId && session.forkRootSessionId
        ? {
            forkedFromSessionId: session.forkedFromSessionId,
            forkRootSessionId: session.forkRootSessionId,
          }
        : null,
    )
    setSessionId(session.sessionId)

    if (echo) {
      const userMsg = createUserMessage(prompt)
      userMsg.uuid = clientMessageUuid as typeof userMsg.uuid
      recordMessage(userMsg, { persist: true })
      userMessageRecorded = true
      const sdkUser = kodeMessageToSdkMessage(userMsg, session.sessionId)
      if (sdkUser) wsSend(sdkUser)

      await waitForDelayOrAbort(echoDelayMs, abortController.signal)
      if (abortController.signal.aborted) {
        sendAbortedResult()
        return
      }

      const assistant = createAssistantMessage(prompt)
      recordAndSendMessage(assistant, { persist: true })
      sendTerminalResult({ result: prompt, isError: false })
      return
    }

    const requestToolPermission = async (params: {
      tool: Tool
      input: Record<string, unknown>
      toolUseContext: ToolUseContext
      assistantMessage: AssistantMessage
    }): Promise<
      | { result: true }
      | {
          result: false
          message: string
          shouldPromptUser?: boolean
        }
    > => {
      const base = await hasPermissionsToUseTool(
        params.tool,
        params.input,
        params.toolUseContext,
        params.assistantMessage,
      )
      if (params.toolUseContext.abortController.signal.aborted) {
        return {
          result: false,
          message: REJECT_MESSAGE,
          shouldPromptUser: false,
        }
      }
      if (base.result === true) return { result: true }

      if (base.shouldPromptUser === false) {
        return {
          result: false,
          message: base.message,
          shouldPromptUser: false,
        }
      }

      const requestId =
        typeof params.toolUseContext.toolUseId === 'string' &&
        params.toolUseContext.toolUseId
          ? params.toolUseContext.toolUseId
          : crypto.randomUUID()

      const toolDescription = await resolveToolDescription(
        params.tool,
        params.input as never,
      )

      const request: PermissionRequest = {
        type: 'permission_request',
        request_id: requestId,
        tool_name: params.tool.name,
        tool_description: toolDescription,
        input: params.input,
      }
      const decision = await waitForPermissionDecision({
        session,
        requestId,
        owner: null,
        signal: params.toolUseContext.abortController.signal,
        sendRequest: () => wsSend(request),
      })

      if (params.toolUseContext.abortController.signal.aborted) {
        return {
          result: false,
          message: REJECT_MESSAGE,
          shouldPromptUser: false,
        }
      }

      if (decision.updatedInput && typeof decision.updatedInput === 'object') {
        Object.assign(params.input, decision.updatedInput)
      }

      if (decision.decision === 'deny') {
        try {
          params.toolUseContext.abortController.abort()
        } catch {
          /* no-op */
        }
        const message =
          decision.rejectionMessage && decision.rejectionMessage.trim()
            ? `${REJECT_MESSAGE_WITH_FEEDBACK_PREFIX}${decision.rejectionMessage.trim()}`
            : REJECT_MESSAGE
        return { result: false, message, shouldPromptUser: false }
      }

      if (decision.decision === 'allow_always') {
        try {
          await savePermission(
            params.tool,
            params.input,
            null,
            params.toolUseContext,
          )
        } catch {
          /* no-op */
        }
      }

      return { result: true }
    }

    const canUseTool: CanUseToolFn = async (
      tool,
      input,
      toolUseContext,
      assistantMessage,
    ) => {
      return await requestToolPermission({
        tool,
        input,
        toolUseContext,
        assistantMessage,
      })
    }

    const [context, systemPrompt] = await Promise.all([
      getContext(),
      buildSystemPromptForSession({ disableSlashCommands: false }),
    ])
    if (abortController.signal.aborted) {
      sendAbortedResult()
      return
    }

    // Do not expose or persist a user turn until all fallible setup has
    // completed. From here, the engine remains the canonical persistence
    // owner for normal turns (including compaction and sidechain records).
    const userMsg = createUserMessage(prompt)
    userMsg.uuid = clientMessageUuid as typeof userMsg.uuid
    recordMessage(userMsg)
    userMessageRecorded = true
    const sdkUser = kodeMessageToSdkMessage(userMsg, session.sessionId)
    if (sdkUser) wsSend(sdkUser)

    const options = {
      commands,
      tools,
      verbose: true,
      safeMode: false,
      forkNumber: 0,
      messageLogName: session.sessionId,
      maxThinkingTokens: 0,
      persistSession: shouldPersistSession,
      toolPermissionContext: session.toolPermissionContext,
      mcpClients,
      shouldAvoidPermissionPrompts: args.shouldAvoidPermissionPrompts === true,
      onStreamEvent: (event: unknown) => {
        if (!shouldForwardStreamEvent(event)) return
        wsSend(
          makeSdkStreamEventMessage({
            sessionId: session.sessionId,
            event,
            parentToolUseId:
              isRecord(event) && typeof event.toolUseId === 'string'
                ? event.toolUseId
                : null,
            uuid: randomUUID(),
          }),
        )
      },
    }

    const baseMessages: Message[] = [...session.messages]

    for await (const m of runTurn({
      messages: baseMessages,
      systemPrompt,
      context,
      canUseTool,
      toolUseContext: {
        options,
        abortController,
        messageId: undefined,
        readFileTimestamps: session.readFileTimestamps,
        setToolJSX: () => {},
        agentId: 'main',
        responseState: session.responseState,
      },
    })) {
      recordAndSendMessage(m)
      if (abortController.signal.aborted) break
    }

    if (abortController.signal.aborted) {
      sendAbortedResult()
      return
    }

    // `lastAssistant` is assigned inside the streaming closure, so CFA still
    // sees the initial `null` here; re-widen it before use.
    const finalAssistant = lastAssistant as AssistantMessage | null
    const resultFromAssistant = finalAssistant
      ? extractFirstAssistantText(finalAssistant.message as ApiMessage)
      : null
    sendTerminalResult({
      result:
        typeof resultFromAssistant === 'string' ? resultFromAssistant : '',
      isError: false,
      usage: finalAssistant?.message?.usage,
    })
  } catch (err) {
    const wasCancelled = abortController.signal.aborted
    try {
      abortController.abort()
    } catch {
      /* no-op */
    }
    if (wasCancelled) {
      sendAbortedResult()
    } else {
      sendTerminalResult({
        result: err instanceof Error ? err.message : String(err),
        isError: true,
        usage: (lastAssistant as AssistantMessage | null)?.message?.usage,
      })
    }
  } finally {
    clearTimeout(timeoutId)
    if (session.activeAbortController === abortController) {
      session.activeAbortController = null
    }
  }
}
