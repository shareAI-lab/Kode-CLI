import type { Tool } from '@kode/core/tooling/Tool'
import type { WrappedClient } from '@kode/mcp/client'
import { isUuid } from '@kode/runtime'
import type { AgentEvent } from '#protocol/agentEvent'
import { makeSdkResultMessage } from '#protocol/utils/kodeAgentStreamJson'

import { handleChatPrompt } from '../handlers/chat.handler'
import { sendSessionList } from '../handlers/session.handler'
import { log } from '../ws/events'
import {
  completeSessionTurn,
  getOrCreateSessionTurn,
  publishSessionEvent,
} from '../ws/sessionBroadcaster'
import type { PersistentSessionService } from '../persistentSessionService'
import type { SessionRegistry } from '../sessionRegistry'
import type { DaemonTurnGate } from '../turnGate'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function makeRecoveredTurnResult(sessionId: string): AgentEvent {
  return makeSdkResultMessage({
    sessionId,
    result:
      'Request already completed before daemon restart; replayed session history is authoritative.',
    numTurns: 0,
    totalCostUsd: 0,
    durationMs: 0,
    durationApiMs: 0,
    isError: true,
  })
}

export async function routeChat(
  req: Request,
  ctx: {
    sessionRegistry: SessionRegistry
    sessionService?: PersistentSessionService
    turnGate: DaemonTurnGate
    resolveCwd: () => Promise<string>
    echo: boolean
    echoDelayMs: number
    commands: unknown[]
    tools: Tool[]
    toolNames: string[]
    slashCommands: string[]
    mcpClients: WrappedClient[]
  },
): Promise<Response | undefined> {
  const url = new URL(req.url)
  if (url.pathname !== '/api/chat') return undefined

  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    body = null
  }

  if (!isRecord(body)) {
    return Response.json(
      { ok: false, error: 'Invalid JSON body' },
      { status: 400 },
    )
  }

  const sessionId =
    typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
  const prompt = typeof body.prompt === 'string' ? body.prompt : ''
  const requestedClientMessageUuid =
    typeof body.clientMessageUuid === 'string'
      ? body.clientMessageUuid.trim()
      : ''

  if (!sessionId) {
    return Response.json(
      { ok: false, error: 'Missing sessionId' },
      { status: 400 },
    )
  }
  if (!isUuid(sessionId)) {
    return Response.json(
      { ok: false, error: 'Invalid sessionId' },
      { status: 400 },
    )
  }
  if (!prompt.trim()) {
    return Response.json(
      { ok: false, error: 'Missing prompt' },
      { status: 400 },
    )
  }
  if (requestedClientMessageUuid && !isUuid(requestedClientMessageUuid)) {
    return Response.json(
      { ok: false, error: 'Invalid clientMessageUuid' },
      { status: 400 },
    )
  }

  const found = ctx.sessionRegistry.getOrLoad({
    cwd: await ctx.resolveCwd(),
    sessionId,
  })
  if (found.ok === false) {
    return Response.json(
      {
        ok: false,
        error:
          found.reason === 'cwd_mismatch'
            ? 'Session workspace mismatch'
            : found.reason === 'archived'
              ? 'Session archived'
              : found.reason === 'metadata_invalid'
                ? 'Session metadata is invalid'
                : 'Unknown session',
      },
      {
        status:
          found.reason === 'cwd_mismatch'
            ? 409
            : found.reason === 'archived'
              ? 410
              : found.reason === 'metadata_invalid'
                ? 500
                : 404,
      },
    )
  }
  const session = found.session
  const clientMessageUuid = requestedClientMessageUuid || crypto.randomUUID()
  const { turn, created } = getOrCreateSessionTurn({
    session,
    clientMessageUuid,
  })

  if (!created) {
    let recoveredTerminal = false
    if (turn.state === 'completed' && !turn.terminalEvent) {
      const terminalEvent = makeRecoveredTurnResult(session.sessionId)
      completeSessionTurn({ session, turn, terminalEvent })
      publishSessionEvent({
        session,
        event: terminalEvent,
        turn,
        audience: 'correlated_only',
        journal: false,
      })
      recoveredTerminal = true
    }
    return Response.json({
      ok: true,
      duplicate: true,
      recoveredTerminal,
      turnId: turn.turnId,
      clientMessageUuid,
    })
  }

  const turnLease = ctx.turnGate.tryAcquire(session)
  if (!turnLease) {
    const busyResult = makeSdkResultMessage({
      sessionId: session.sessionId,
      result: 'Session already has an active prompt',
      numTurns: 0,
      totalCostUsd: 0,
      durationMs: 0,
      durationApiMs: 0,
      isError: true,
    })
    completeSessionTurn({ session, turn, terminalEvent: busyResult })
    publishSessionEvent({
      session,
      event: busyResult,
      turn,
      // HTTP callers receive the correlated terminal response directly. Do
      // not inject a foreign raw result into an attached legacy WS stream.
      audience: 'correlated_only',
      journal: false,
    })
    return Response.json(
      {
        ok: false,
        error: 'Session already has an active prompt',
        turnId: turn.turnId,
        clientMessageUuid,
      },
      { status: 409 },
    )
  }
  publishSessionEvent({
    session,
    event: {
      type: 'turn_state',
      session_id: session.sessionId,
      state: 'running',
    },
    turn,
  })

  const wsSend = (payload: AgentEvent) => {
    if (payload.type === 'result') turn.terminalEvent = payload
    publishSessionEvent({ session, event: payload, turn })
  }

  void (async () => {
    try {
      await handleChatPrompt({
        wsSend,
        session,
        prompt,
        clientMessageUuid,
        echo: ctx.echo,
        echoDelayMs: ctx.echoDelayMs,
        commands: ctx.commands,
        tools: ctx.tools,
        toolNames: ctx.toolNames,
        slashCommands: ctx.slashCommands,
        mcpClients: ctx.mcpClients,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      session.activeAbortController = null
      wsSend(
        makeSdkResultMessage({
          sessionId: session.sessionId,
          result: message,
          numTurns: 0,
          totalCostUsd: 0,
          durationMs: 0,
          durationApiMs: 0,
          isError: true,
        }),
      )
      wsSend(log('error', message))
    } finally {
      completeSessionTurn({ session, turn })
      turnLease.release()
      ctx.sessionRegistry.evictIdleSessions()
      publishSessionEvent({
        session,
        event: {
          type: 'turn_state',
          session_id: session.sessionId,
          state: 'idle',
        },
        turn,
      })
      for (const client of Array.from(session.clients)) {
        try {
          sendSessionList(client, {
            cwd: session.cwd,
            ...(ctx.sessionService
              ? {
                  listSessions: () =>
                    ctx.sessionService?.list({ cwd: session.cwd }) ?? [],
                }
              : {}),
            onError: message => wsSend(log('error', message)),
          })
        } catch {
          /* no-op */
        }
      }
    }
  })()

  return Response.json({ ok: true, turnId: turn.turnId, clientMessageUuid })
}
