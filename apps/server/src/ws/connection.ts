import type { RawData, WebSocket } from 'ws'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

import {
  makeSdkInitMessage,
  makeSdkResultMessage,
  kodeMessageToSdkMessage,
} from '#protocol/utils/kodeAgentStreamJson'
import type { AgentEvent } from '#protocol/agentEvent'
import { isUuid } from '@kode/runtime'
import { setCwd, setOriginalCwd } from '@kode/core/utils/state'
import { grantReadPermissionForOriginalDir } from '@kode/core/utils/permissions/filesystem'
import type { WrappedClient } from '@kode/mcp/client'
import { hasPermissionsToUseTool, savePermission } from '@kode/core/permissions'
import { runBuiltinPreToolUseGuards } from '@kode/hooks/builtin/preToolUse'
import {
  createAssistantMessage,
  REJECT_MESSAGE,
  REJECT_MESSAGE_WITH_FEEDBACK_PREFIX,
} from '@kode/core/utils/messages'

import type { Tool, ToolUseContext } from '@kode/core/tooling/Tool'
import { resolveToolDescription } from '@kode/core/tooling/Tool'

import { sendSessionList } from '../handlers/session.handler'
import { handleChatPrompt } from '../handlers/chat.handler'
import { parseClientWsMessage, sendJson, log } from './events'
import type { DaemonClient, DaemonSession, DaemonTurn } from './types'
import {
  denyAllPermissionRequests,
  denyPermissionRequestsOwnedBy,
  resolvePermissionRequest,
  waitForPermissionDecision,
} from './permissionRequests'
import {
  addSessionClient,
  allocateSessionSequence,
  completeSessionTurn,
  getOrCreateSessionTurn,
  publishSessionEvent,
  replaySessionJournalToClient,
  removeSessionClient,
  sendSessionEventToClient,
} from './sessionBroadcaster'
import { resolveInProjectRoot, toGitPath } from '../server/pathSecurity'
import { PersistentSessionService } from '../persistentSessionService'
import type { SessionRegistry } from '../sessionRegistry'
import type { DaemonTurnGate } from '../turnGate'

type WsWithSession = WebSocket & {
  data: {
    session: DaemonSession
    replayHistory: boolean
    correlatedEvents: boolean
    afterSequence: number | null
  }
}

type PermissionRequest = {
  type: 'permission_request'
  request_id: string
  tool_name: string
  tool_description: string
  input: Record<string, unknown>
}

function runGit(
  args: string[],
  cwd: string,
): { ok: true; stdout: string } | { ok: false; error: string } {
  try {
    const res = spawnSync('git', args, { cwd, encoding: 'utf8' })
    if (res.status === 0) return { ok: true, stdout: String(res.stdout ?? '') }
    const stderr = String(res.stderr ?? '')
    const stdout = String(res.stdout ?? '')
    return { ok: false, error: stderr.trim() || stdout.trim() || 'git failed' }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

function parseGitStatusPorcelain(
  stdout: string,
): Array<{ path: string; status: string }> {
  const lines = stdout.split(/\r?\n/).filter(Boolean)
  return lines.flatMap(line => {
    // Porcelain v1 format: XY <path> (may include rename "R  old -> new")
    if (line.length < 4) return []
    const status = line.slice(0, 2)
    const rest = line.slice(3).trim()
    if (!rest) return []
    const arrowIdx = rest.indexOf(' -> ')
    const path = arrowIdx >= 0 ? rest.slice(arrowIdx + 4).trim() : rest
    return path ? [{ path, status }] : []
  })
}

function sendSessionListToClient(
  ws: WsWithSession,
  session: DaemonSession,
  sessionService: PersistentSessionService,
) {
  sendSessionList(ws, {
    cwd: session.cwd,
    listSessions: () => sessionService.list({ cwd: session.cwd }),
    onError: message => sendJson(ws, log('error', message)),
  })
}

function broadcastSessionList(
  session: DaemonSession,
  sessionService: PersistentSessionService,
) {
  for (const client of Array.from(session.clients)) {
    sendSessionList(client, {
      cwd: session.cwd,
      listSessions: () => sessionService.list({ cwd: session.cwd }),
      onError: message => sendJson(client, log('error', message)),
    })
  }
}

function replaySessionHistory(ws: WsWithSession, session: DaemonSession) {
  if (ws.data.correlatedEvents) {
    const oldestJournalSequence = session.eventJournal[0]?.metadata.sequence
    const canReplayFromCursor =
      ws.data.afterSequence !== null &&
      oldestJournalSequence !== undefined &&
      ws.data.afterSequence >= oldestJournalSequence - 1
    const snapshot = !canReplayFromCursor

    sendSessionEventToClient({
      client: ws,
      session,
      event: { type: 'history_begin', sessionId: session.sessionId },
      replayed: true,
      snapshot,
      sequence: 0,
    })

    if (canReplayFromCursor) {
      replaySessionJournalToClient({
        client: ws,
        session,
        afterSequence: ws.data.afterSequence ?? 0,
      })
    } else {
      // A clean attach, daemon reload, or cursor older than the bounded journal
      // gets a durable message snapshot rather than an incomplete tail.
      for (const m of session.messages) {
        const sdk = kodeMessageToSdkMessage(m, session.sessionId)
        if (!sdk) continue
        sendSessionEventToClient({
          client: ws,
          session,
          event: sdk,
          replayed: true,
          snapshot: true,
          sequence: 0,
        })
      }
    }

    sendSessionEventToClient({
      client: ws,
      session,
      event: { type: 'history_end', sessionId: session.sessionId },
      replayed: true,
      snapshot,
      sequence: 0,
    })
    return
  }

  sendJson(ws, { type: 'history_begin', sessionId: session.sessionId })
  for (const m of session.messages) {
    const sdk = kodeMessageToSdkMessage(m, session.sessionId)
    if (sdk) sendJson(ws, sdk)
  }
  sendJson(ws, { type: 'history_end', sessionId: session.sessionId })
}

function makeTurnState(session: DaemonSession): AgentEvent {
  return {
    type: 'turn_state' as const,
    session_id: session.sessionId,
    state: session.turnInFlight ? ('running' as const) : ('idle' as const),
  }
}

function makeRecoveredTurnResult(session: DaemonSession): AgentEvent {
  return makeSdkResultMessage({
    sessionId: session.sessionId,
    result:
      'Request already completed before daemon restart; replayed session history is authoritative.',
    numTurns: 0,
    totalCostUsd: 0,
    durationMs: 0,
    durationApiMs: 0,
    isError: true,
  })
}

function moveClientToSession(
  ws: WsWithSession,
  nextSession: DaemonSession,
): void {
  const previousSession = ws.data.session
  if (previousSession === nextSession) return

  removeSessionClient(previousSession, ws)
  denyPermissionRequestsOwnedBy(previousSession, ws, 'Disconnected')
  if (previousSession.clients.size === 0) {
    denyAllPermissionRequests(previousSession, 'Disconnected')
  }
  ws.data.session = nextSession
  ws.data.afterSequence = null
  addSessionClient(nextSession, ws)
}

export function createWebSocketHandlers(args: {
  sessionRegistry: SessionRegistry
  sessionService?: PersistentSessionService
  turnGate: DaemonTurnGate
  toolNames: string[]
  slashCommands: string[]
  commands: unknown[]
  tools: Tool[]
  echo: boolean
  echoDelayMs: number
  mcpClients: WrappedClient[]
  promptHandler?: typeof handleChatPrompt
}) {
  const bashTool = args.tools.find(t => t.name === 'Bash') ?? null
  const promptHandler = args.promptHandler ?? handleChatPrompt
  const activeOperationOwners = new Map<DaemonSession, DaemonClient>()
  const sessionService =
    args.sessionService ?? new PersistentSessionService(args.sessionRegistry)

  const requestToolPermission = async (params: {
    ws: WsWithSession
    session: DaemonSession
    tool: Tool
    input: Record<string, unknown>
    abortController: AbortController
  }): Promise<
    { ok: true } | { ok: false; message: string; shouldPromptUser?: boolean }
  > => {
    const toolUseContext: ToolUseContext = {
      agentId: 'main',
      messageId: undefined,
      abortController: params.abortController,
      readFileTimestamps: params.session.readFileTimestamps,
      options: {
        safeMode: false,
        toolPermissionContext: params.session.toolPermissionContext,
        // Ensure sandbox/permission checks use the selected workspace cwd.
        __sandboxProjectDir: params.session.cwd,
      },
    }

    const assistantMessage = createAssistantMessage('')
    const base = await hasPermissionsToUseTool(
      params.tool,
      params.input,
      toolUseContext,
      assistantMessage,
    )
    if (params.abortController.signal.aborted) {
      return { ok: false, message: REJECT_MESSAGE, shouldPromptUser: false }
    }
    if (base.result === true) return { ok: true }

    if (base.shouldPromptUser === false) {
      return {
        ok: false,
        message: base.message,
        shouldPromptUser: false,
      }
    }

    if (toolUseContext.abortController.signal.aborted) {
      return { ok: false, message: REJECT_MESSAGE, shouldPromptUser: false }
    }

    const requestId = crypto.randomUUID()

    const toolDescription = await resolveToolDescription(
      params.tool,
      params.input as never,
    )
    if (params.abortController.signal.aborted) {
      return { ok: false, message: REJECT_MESSAGE, shouldPromptUser: false }
    }

    const request: PermissionRequest = {
      type: 'permission_request',
      request_id: requestId,
      tool_name: params.tool.name,
      tool_description: toolDescription,
      input: params.input,
    }
    const decision = await waitForPermissionDecision({
      session: params.session,
      requestId,
      owner: params.ws,
      signal: toolUseContext.abortController.signal,
      sendRequest: () => sendJson(params.ws, request),
    })

    if (params.abortController.signal.aborted) {
      return { ok: false, message: REJECT_MESSAGE, shouldPromptUser: false }
    }

    if (decision.updatedInput && typeof decision.updatedInput === 'object') {
      Object.assign(params.input, decision.updatedInput)
    }

    if (decision.decision === 'deny') {
      const message =
        decision.rejectionMessage && decision.rejectionMessage.trim()
          ? `${REJECT_MESSAGE_WITH_FEEDBACK_PREFIX}${decision.rejectionMessage.trim()}`
          : REJECT_MESSAGE
      return { ok: false, message, shouldPromptUser: false }
    }

    if (decision.decision === 'allow_always') {
      try {
        await savePermission(params.tool, params.input, null, toolUseContext)
      } catch {
        /* no-op */
      }
    }

    return { ok: true }
  }

  const runExclusiveWorkspaceOperation = async (params: {
    session: DaemonSession
    owner: DaemonClient
    onBusy: () => void
    operation: (abortController: AbortController) => void | Promise<void>
  }): Promise<void> => {
    const lease = args.turnGate.tryAcquire(params.session)
    if (!lease) {
      params.onBusy()
      return
    }
    const abortController = new AbortController()
    params.session.activeAbortController = abortController
    activeOperationOwners.set(params.session, params.owner)
    try {
      await params.operation(abortController)
    } finally {
      try {
        abortController.abort()
      } catch {
        /* no-op */
      }
      if (params.session.activeAbortController === abortController) {
        params.session.activeAbortController = null
      }
      if (activeOperationOwners.get(params.session) === params.owner) {
        activeOperationOwners.delete(params.session)
      }
      lease.release()
      args.sessionRegistry.evictIdleSessions()
    }
  }

  return {
    open(ws: WsWithSession) {
      const session = ws.data.session
      addSessionClient(session, ws)
      sendSessionEventToClient({
        client: ws,
        session,
        event: makeSdkInitMessage({
          sessionId: session.sessionId,
          cwd: session.cwd,
          tools: args.toolNames,
          slashCommands: args.slashCommands,
        }),
      })
      if (ws.data.replayHistory) replaySessionHistory(ws, session)
      sendSessionEventToClient({
        client: ws,
        session,
        event: makeTurnState(session),
      })
      sendSessionListToClient(ws, session, sessionService)
    },

    async message(ws: WsWithSession, message: RawData) {
      const session = ws.data.session
      const parsed = parseClientWsMessage(message)
      if (parsed.ok === false) {
        sendJson(ws, log('error', parsed.error))
        return
      }

      const payload = parsed.value

      if (payload.type === 'cancel') {
        const hasTurnSelector = Boolean(
          payload.turnId || payload.clientMessageUuid,
        )
        const selectedTurn = (
          Array.from(session.turnsByClientMessageUuid.values()) as DaemonTurn[]
        ).find(turn => {
          if (turn.state !== 'running') return false
          if (payload.turnId && turn.turnId !== payload.turnId) return false
          if (
            payload.clientMessageUuid &&
            turn.clientMessageUuid !== payload.clientMessageUuid
          ) {
            return false
          }
          return true
        })
        if (hasTurnSelector && !selectedTurn) return
        try {
          session.activeAbortController?.abort()
        } catch {
          /* no-op */
        }
        denyAllPermissionRequests(session, 'Cancelled')
        return
      }

      if (payload.type === 'permission_response') {
        try {
          resolvePermissionRequest(session, payload.requestId, ws, {
            decision: payload.decision,
            updatedInput: payload.updatedInput,
            rejectionMessage: payload.rejectionMessage,
          })
        } catch {
          /* no-op */
        }
        return
      }

      if (payload.type === 'list_sessions') {
        sendSessionListToClient(ws, session, sessionService)
        return
      }

      if (payload.type === 'new_session') {
        if (session.turnInFlight) {
          sendJson(
            ws,
            log('error', 'Cannot switch sessions during an active turn'),
          )
          return
        }
        const nextSession = args.sessionRegistry.create(session.cwd)
        moveClientToSession(ws, nextSession)
        args.sessionRegistry.evictIdleSessions()
        sendSessionEventToClient({
          client: ws,
          session: nextSession,
          event: makeSdkInitMessage({
            sessionId: nextSession.sessionId,
            cwd: nextSession.cwd,
            tools: args.toolNames,
            slashCommands: args.slashCommands,
          }),
        })
        replaySessionHistory(ws, nextSession)
        sendSessionEventToClient({
          client: ws,
          session: nextSession,
          event: makeTurnState(nextSession),
        })
        sendSessionListToClient(ws, nextSession, sessionService)
        return
      }

      if (payload.type === 'resume') {
        if (session.turnInFlight) {
          sendJson(
            ws,
            log('error', 'Cannot switch sessions during an active turn'),
          )
          return
        }
        if (!isUuid(payload.sessionId)) {
          sendJson(ws, log('error', 'Invalid session_id'))
          return
        }

        const found = args.sessionRegistry.getOrLoad({
          cwd: session.cwd,
          sessionId: payload.sessionId,
        })
        if (found.ok === false) {
          sendJson(
            ws,
            log(
              'error',
              found.reason === 'cwd_mismatch'
                ? 'Session workspace mismatch'
                : found.reason === 'archived'
                  ? 'Session archived'
                  : found.reason === 'metadata_invalid'
                    ? 'Session metadata is invalid'
                    : `Session not found: ${payload.sessionId}`,
            ),
          )
          return
        }
        moveClientToSession(ws, found.session)
        args.sessionRegistry.evictIdleSessions()
        sendSessionEventToClient({
          client: ws,
          session: found.session,
          event: makeSdkInitMessage({
            sessionId: found.session.sessionId,
            cwd: found.session.cwd,
            tools: args.toolNames,
            slashCommands: args.slashCommands,
          }),
        })
        replaySessionHistory(ws, found.session)
        sendSessionEventToClient({
          client: ws,
          session: found.session,
          event: makeTurnState(found.session),
        })
        sendSessionListToClient(ws, found.session, sessionService)
        return
      }

      if (payload.type === 'prompt') {
        const clientMessageUuid =
          payload.clientMessageUuid ?? crypto.randomUUID()
        const { turn, created } = getOrCreateSessionTurn({
          session,
          clientMessageUuid,
        })

        // A retry with the same client-owned UUID attaches to the existing
        // daemon turn instead of creating a second optimistic user message.
        if (!created) {
          if (ws.data.correlatedEvents) {
            replaySessionJournalToClient({
              client: ws,
              session,
              afterSequence: ws.data.afterSequence ?? 0,
            })
          }
          if (turn.state === 'completed') {
            const terminalEvent =
              turn.terminalEvent ?? makeRecoveredTurnResult(session)
            if (!turn.terminalEvent) {
              completeSessionTurn({ session, turn, terminalEvent })
            }
            sendSessionEventToClient({
              client: ws,
              session,
              event: terminalEvent,
              turn,
              sequence: allocateSessionSequence(session),
            })
          } else {
            sendSessionEventToClient({
              client: ws,
              session,
              event: makeTurnState(session),
              turn,
            })
          }
          return
        }

        const turnLease = args.turnGate.tryAcquire(session)
        if (!turnLease) {
          const busyResult = makeSdkResultMessage({
            sessionId: session.sessionId,
            result: 'Another turn is already active',
            numTurns: 0,
            totalCostUsd: 0,
            durationMs: 0,
            durationApiMs: 0,
            isError: true,
          })
          completeSessionTurn({ session, turn, terminalEvent: busyResult })
          sendSessionEventToClient({
            client: ws,
            session,
            event: busyResult,
            turn,
            sequence: allocateSessionSequence(session),
          })
          return
        }
        publishSessionEvent({
          session,
          event: makeTurnState(session),
          turn,
        })

        const wsSend = (outgoing: AgentEvent) => {
          if (outgoing.type === 'result') turn.terminalEvent = outgoing
          publishSessionEvent({ session, event: outgoing, turn })
        }

        try {
          await promptHandler({
            wsSend,
            session,
            prompt: payload.prompt,
            clientMessageUuid,
            echo: args.echo,
            echoDelayMs: args.echoDelayMs,
            commands: args.commands,
            tools: args.tools,
            toolNames: args.toolNames,
            slashCommands: args.slashCommands,
            mcpClients: args.mcpClients,
          })
        } catch (err) {
          session.activeAbortController = null
          denyAllPermissionRequests(session, 'Turn failed')
          wsSend(
            makeSdkResultMessage({
              sessionId: session.sessionId,
              result: err instanceof Error ? err.message : String(err),
              numTurns: 0,
              totalCostUsd: 0,
              durationMs: 0,
              durationApiMs: 0,
              isError: true,
            }),
          )
        } finally {
          completeSessionTurn({ session, turn })
          turnLease.release()
          args.sessionRegistry.evictIdleSessions()
          publishSessionEvent({
            session,
            event: makeTurnState(session),
            turn,
          })
          broadcastSessionList(session, sessionService)
        }
      }

      if (payload.type === 'fs_read') {
        await runExclusiveWorkspaceOperation({
          session,
          owner: ws,
          onBusy: () =>
            sendJson(ws, log('error', 'Workspace is busy with an active turn')),
          operation: async abortController => {
            try {
              setOriginalCwd(session.cwd)
              await setCwd(session.cwd)
              if (abortController.signal.aborted) {
                sendJson(ws, log('info', 'Operation cancelled'))
                return
              }
              grantReadPermissionForOriginalDir()

              const abs = resolveInProjectRoot(session.cwd, payload.path)
              const content = readFileSync(abs, 'utf8')
              sendJson(ws, {
                type: 'fs_read_result',
                ok: true,
                path: payload.path,
                content,
              })
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              sendJson(ws, log('error', msg))
            }
          },
        })
        return
      }

      if (payload.type === 'fs_write') {
        await runExclusiveWorkspaceOperation({
          session,
          owner: ws,
          onBusy: () =>
            sendJson(ws, {
              type: 'fs_write_result',
              ok: false,
              path: payload.path,
              message: 'Workspace is busy with an active turn',
            }),
          operation: async abortController => {
            try {
              setOriginalCwd(session.cwd)
              await setCwd(session.cwd)
              if (abortController.signal.aborted) {
                sendJson(ws, {
                  type: 'fs_write_result',
                  ok: false,
                  path: payload.path,
                  message: 'Operation cancelled',
                })
                return
              }
              grantReadPermissionForOriginalDir()

              const abs = resolveInProjectRoot(session.cwd, payload.path)

              const writeTool = args.tools.find(t => t.name === 'Write') ?? null
              if (writeTool) {
                const permission = await requestToolPermission({
                  ws,
                  session,
                  tool: writeTool,
                  input: { file_path: abs, content: payload.content },
                  abortController,
                })
                if (permission.ok === false) {
                  sendJson(ws, {
                    type: 'fs_write_result',
                    ok: false,
                    path: payload.path,
                    message: permission.message,
                  })
                  return
                }
              }

              if (abortController.signal.aborted) {
                sendJson(ws, {
                  type: 'fs_write_result',
                  ok: false,
                  path: payload.path,
                  message: 'Operation cancelled',
                })
                return
              }

              writeFileSync(abs, payload.content, { encoding: 'utf8' })
              sendJson(ws, {
                type: 'fs_write_result',
                ok: true,
                path: payload.path,
              })
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              sendJson(ws, {
                type: 'fs_write_result',
                ok: false,
                path: payload.path,
                message: msg,
              })
            }
          },
        })
        return
      }

      if (payload.type === 'git_branches') {
        const res = runGit(['branch', '--format=%(refname:short)'], session.cwd)
        if (res.ok === false) {
          sendJson(ws, log('error', res.error))
          return
        }
        const branches = res.stdout
          .split(/\r?\n/)
          .map(l => l.trim())
          .filter(Boolean)
        sendJson(ws, { type: 'git_branches_result', branches })
        return
      }

      if (payload.type === 'git_checkout') {
        await runExclusiveWorkspaceOperation({
          session,
          owner: ws,
          onBusy: () =>
            sendJson(ws, {
              type: 'git_checkout_result',
              ok: false,
              message: 'Workspace is busy with an active turn',
            }),
          operation: async abortController => {
            if (!bashTool) {
              sendJson(ws, {
                type: 'git_checkout_result',
                ok: false,
                message: 'Bash tool unavailable',
              })
              return
            }

            const checkoutCommand = `git checkout ${JSON.stringify(payload.branch)}`
            const builtinOutcome = runBuiltinPreToolUseGuards({
              toolName: 'Bash',
              toolInput: { command: checkoutCommand },
              cwd: session.cwd,
            })
            if (builtinOutcome?.kind === 'block') {
              sendJson(ws, {
                type: 'git_checkout_result',
                ok: false,
                message: builtinOutcome.message,
              })
              return
            }

            const commandInput = { command: checkoutCommand }
            const permission = await requestToolPermission({
              ws,
              session,
              tool: bashTool,
              input: commandInput,
              abortController,
            })
            if (permission.ok === false) {
              sendJson(ws, {
                type: 'git_checkout_result',
                ok: false,
                message: abortController.signal.aborted
                  ? 'Operation cancelled'
                  : permission.message,
              })
              return
            }

            if (abortController.signal.aborted) {
              sendJson(ws, {
                type: 'git_checkout_result',
                ok: false,
                message: 'Operation cancelled',
              })
              return
            }

            const res = runGit(['checkout', payload.branch], session.cwd)
            if (res.ok === false) {
              sendJson(ws, {
                type: 'git_checkout_result',
                ok: false,
                message: res.error,
              })
              return
            }
            sendJson(ws, { type: 'git_checkout_result', ok: true })
          },
        })
        return
      }

      if (payload.type === 'git_status') {
        const isRepo = runGit(
          ['rev-parse', '--is-inside-work-tree'],
          session.cwd,
        )
        if (!isRepo.ok) {
          sendJson(ws, {
            type: 'git_status_result',
            isRepo: false,
            branch: null,
            entries: [],
          })
          return
        }

        const branchRes = runGit(
          ['rev-parse', '--abbrev-ref', 'HEAD'],
          session.cwd,
        )
        const branch = branchRes.ok ? branchRes.stdout.trim() : null
        const statusRes = runGit(['status', '--porcelain=v1'], session.cwd)
        const entries = statusRes.ok
          ? parseGitStatusPorcelain(statusRes.stdout)
          : []

        sendJson(ws, {
          type: 'git_status_result',
          isRepo: true,
          branch,
          entries,
        })
        return
      }

      if (payload.type === 'git_diff') {
        try {
          const relPath = toGitPath(session.cwd, payload.path)
          const diffArgs = payload.staged
            ? ['diff', '--cached', '--', relPath]
            : ['diff', '--', relPath]
          const res = runGit(diffArgs, session.cwd)
          if (res.ok === false) {
            sendJson(ws, {
              type: 'git_diff_result',
              ok: false,
              path: payload.path,
              message: res.error,
            })
            return
          }
          sendJson(ws, {
            type: 'git_diff_result',
            ok: true,
            path: payload.path,
            diff: res.stdout,
          })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          sendJson(ws, {
            type: 'git_diff_result',
            ok: false,
            path: payload.path,
            message: msg,
          })
        }
        return
      }

      if (payload.type === 'git_stage') {
        await runExclusiveWorkspaceOperation({
          session,
          owner: ws,
          onBusy: () =>
            sendJson(ws, {
              type: 'git_action_result',
              ok: false,
              action: 'stage',
              message: 'Workspace is busy with an active turn',
            }),
          operation: async abortController => {
            if (!bashTool) {
              sendJson(ws, {
                type: 'git_action_result',
                ok: false,
                action: 'stage',
                message: 'Bash tool unavailable',
              })
              return
            }

            let relPath: string
            try {
              relPath = toGitPath(session.cwd, payload.path)
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              sendJson(ws, {
                type: 'git_action_result',
                ok: false,
                action: 'stage',
                message: msg,
              })
              return
            }

            const permission = await requestToolPermission({
              ws,
              session,
              tool: bashTool,
              input: { command: `git add -- ${JSON.stringify(relPath)}` },
              abortController,
            })
            if (permission.ok === false) {
              sendJson(ws, {
                type: 'git_action_result',
                ok: false,
                action: 'stage',
                message: abortController.signal.aborted
                  ? 'Operation cancelled'
                  : permission.message,
              })
              return
            }

            if (abortController.signal.aborted) {
              sendJson(ws, {
                type: 'git_action_result',
                ok: false,
                action: 'stage',
                message: 'Operation cancelled',
              })
              return
            }

            const res = runGit(['add', '--', relPath], session.cwd)
            if (res.ok === false) {
              sendJson(ws, {
                type: 'git_action_result',
                ok: false,
                action: 'stage',
                message: res.error,
              })
              return
            }
            sendJson(ws, {
              type: 'git_action_result',
              ok: true,
              action: 'stage',
            })
          },
        })
        return
      }

      if (payload.type === 'git_commit') {
        await runExclusiveWorkspaceOperation({
          session,
          owner: ws,
          onBusy: () =>
            sendJson(ws, {
              type: 'git_commit_result',
              ok: false,
              message: 'Workspace is busy with an active turn',
            }),
          operation: async abortController => {
            if (!bashTool) {
              sendJson(ws, {
                type: 'git_commit_result',
                ok: false,
                message: 'Bash tool unavailable',
              })
              return
            }

            const permission = await requestToolPermission({
              ws,
              session,
              tool: bashTool,
              input: {
                command: `git commit -m ${JSON.stringify(payload.message)}`,
              },
              abortController,
            })
            if (permission.ok === false) {
              sendJson(ws, {
                type: 'git_commit_result',
                ok: false,
                message: abortController.signal.aborted
                  ? 'Operation cancelled'
                  : permission.message,
              })
              return
            }

            if (abortController.signal.aborted) {
              sendJson(ws, {
                type: 'git_commit_result',
                ok: false,
                message: 'Operation cancelled',
              })
              return
            }

            const res = runGit(['commit', '-m', payload.message], session.cwd)
            if (res.ok === false) {
              sendJson(ws, {
                type: 'git_commit_result',
                ok: false,
                message: res.error,
              })
              return
            }
            sendJson(ws, { type: 'git_commit_result', ok: true })
          },
        })
        return
      }
    },

    close(ws: WsWithSession) {
      const session = ws.data.session
      if (activeOperationOwners.get(session) === ws) {
        try {
          session.activeAbortController?.abort()
        } catch {
          /* no-op */
        }
      }
      removeSessionClient(session, ws)
      denyPermissionRequestsOwnedBy(session, ws, 'Disconnected')
      if (session.clients.size === 0) {
        denyAllPermissionRequests(session, 'Disconnected')
      }
      args.sessionRegistry.evictIdleSessions()
    },
  }
}
