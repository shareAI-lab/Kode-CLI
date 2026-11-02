import type { RawData, WebSocket } from 'ws'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { SettingsFileError } from '@kode/config'

import {
  makeSdkInitMessage,
  kodeMessageToSdkMessage,
} from '#protocol/utils/kodeAgentStreamJson'
import { isUuid } from '@kode/core/utils/uuid'
import { loadToolPermissionContextFromDisk } from '@kode/core/utils/permissions/toolPermissionSettings'
import { setCwd, setOriginalCwd } from '@kode/core/utils/state'
import { grantReadPermissionForOriginalDir } from '@kode/core/utils/permissions/filesystem'
import { hasPermissionsToUseTool, savePermission } from '@kode/core/permissions'
import { runBuiltinPreToolUseGuards } from '@kode/core/hooks/builtin/preToolUse'
import {
  createAssistantMessage,
  REJECT_MESSAGE,
  REJECT_MESSAGE_WITH_FEEDBACK_PREFIX,
} from '@kode/core/utils/messages'

import type { Tool, ToolUseContext } from '@kode/core/tooling/Tool'
import { resolveToolDescription } from '@kode/core/tooling/Tool'

import {
  sendSessionList,
  loadSessionMessages,
} from '../handlers/session.handler'
import { handleChatPrompt } from '../handlers/chat.handler'
import { parseClientWsMessage, sendJson, log } from './events'
import type { DaemonSession, InflightPermissionDecision } from './types'
import { resolveInProjectRoot, toGitPath } from '../server/pathSecurity'

type WsWithSession = WebSocket & { data: { session: DaemonSession } }

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

export function createWebSocketHandlers(args: {
  sessions: Map<string, DaemonSession>
  toolNames: string[]
  slashCommands: string[]
  commands: unknown[]
  tools: Tool[]
  echo: boolean
}) {
  const bashTool = args.tools.find(t => t.name === 'Bash') ?? null

  const requestToolPermission = async (params: {
    ws: WsWithSession
    session: DaemonSession
    tool: Tool
    input: Record<string, unknown>
  }): Promise<
    { ok: true } | { ok: false; message: string; shouldPromptUser?: boolean }
  > => {
    const toolUseContext: ToolUseContext = {
      agentId: 'main',
      messageId: undefined,
      abortController: new AbortController(),
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

    const request: PermissionRequest = {
      type: 'permission_request',
      request_id: requestId,
      tool_name: params.tool.name,
      tool_description: toolDescription,
      input: params.input,
    }
    sendJson(params.ws, request)

    const decision = await new Promise<InflightPermissionDecision>(resolve => {
      params.session.inflightPermissionRequests.set(requestId, resolve)
    })

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
      } catch {}
    }

    return { ok: true }
  }

  return {
    open(ws: WsWithSession) {
      const session = ws.data.session
      session.ws = ws
      sendJson(
        ws,
        makeSdkInitMessage({
          sessionId: session.sessionId,
          cwd: session.cwd,
          tools: args.toolNames,
          slashCommands: args.slashCommands,
        }),
      )
      sendSessionList(ws, {
        cwd: session.cwd,
        onError: message => sendJson(ws, log('error', message)),
      })
    },

    async message(ws: WsWithSession, message: RawData) {
      const session = ws.data.session
      // Ignore queued frames after a failed initialization or a closed session.
      if (args.sessions.get(session.sessionId) !== session) return
      const parsed = parseClientWsMessage(message)
      if (parsed.ok === false) {
        sendJson(ws, log('error', parsed.error))
        return
      }

      const payload = parsed.value

      if (payload.type === 'cancel') {
        try {
          session.activeAbortController?.abort()
        } catch {}
        for (const resolve of session.inflightPermissionRequests.values()) {
          try {
            resolve({
              decision: 'deny',
              rejectionMessage: 'Cancelled',
              updatedInput: null,
            })
          } catch {}
        }
        session.inflightPermissionRequests.clear()
        return
      }

      if (payload.type === 'permission_response') {
        const resolve = session.inflightPermissionRequests.get(
          payload.requestId,
        )
        if (!resolve) return
        session.inflightPermissionRequests.delete(payload.requestId)
        try {
          resolve({
            decision: payload.decision,
            updatedInput: payload.updatedInput,
            rejectionMessage: payload.rejectionMessage,
          })
        } catch {}
        return
      }

      if (payload.type === 'list_sessions') {
        sendSessionList(ws, {
          cwd: session.cwd,
          onError: message => sendJson(ws, log('error', message)),
        })
        return
      }

      if (payload.type === 'new_session') {
        try {
          session.activeAbortController?.abort()
        } catch {}
        for (const resolve of session.inflightPermissionRequests.values()) {
          try {
            resolve({
              decision: 'deny',
              rejectionMessage: 'Cancelled',
              updatedInput: null,
            })
          } catch {}
        }
        session.inflightPermissionRequests.clear()

        session.messages = []
        session.readFileTimestamps = {}
        session.responseState = {}
        session.activeAbortController = null

        try {
          session.toolPermissionContext = loadToolPermissionContextFromDisk({
            projectDir: session.cwd,
            includeKodeProjectConfig: true,
            isBypassPermissionsModeAvailable: true,
          })
        } catch (error) {
          if (!(error instanceof SettingsFileError)) throw error
          sendJson(ws, log('error', error.message))
          // Do not leave a failed new-session request using the old policy.
          args.sessions.delete(session.sessionId)
          ws.close(1011, 'Cannot load permission settings')
          return
        }

        const nextId = crypto.randomUUID()
        args.sessions.delete(session.sessionId)
        session.sessionId = nextId
        args.sessions.set(session.sessionId, session)

        sendJson(
          ws,
          makeSdkInitMessage({
            sessionId: session.sessionId,
            cwd: session.cwd,
            tools: args.toolNames,
            slashCommands: args.slashCommands,
          }),
        )
        sendSessionList(ws, {
          cwd: session.cwd,
          onError: message => sendJson(ws, log('error', message)),
        })
        return
      }

      if (payload.type === 'resume') {
        if (!isUuid(payload.sessionId)) {
          sendJson(ws, log('error', 'Invalid session_id'))
          return
        }

        try {
          const loaded = loadSessionMessages({
            cwd: session.cwd,
            sessionId: payload.sessionId,
          })

          session.messages = loaded
          session.readFileTimestamps = {}
          session.responseState = {}
          try {
            session.activeAbortController?.abort()
          } catch {}
          session.activeAbortController = null

          args.sessions.delete(session.sessionId)
          session.sessionId = payload.sessionId
          args.sessions.set(session.sessionId, session)

          sendJson(
            ws,
            makeSdkInitMessage({
              sessionId: session.sessionId,
              cwd: session.cwd,
              tools: args.toolNames,
              slashCommands: args.slashCommands,
            }),
          )

          sendJson(ws, { type: 'history_begin', sessionId: session.sessionId })
          for (const m of loaded) {
            const sdk = kodeMessageToSdkMessage(m, session.sessionId)
            if (sdk) sendJson(ws, sdk)
          }
          sendJson(ws, { type: 'history_end', sessionId: session.sessionId })

          sendSessionList(ws, {
            cwd: session.cwd,
            onError: message => sendJson(ws, log('error', message)),
          })
        } catch (err) {
          sendJson(
            ws,
            log('error', err instanceof Error ? err.message : String(err)),
          )
        }
        return
      }

      if (payload.type === 'prompt') {
        if (session.activeAbortController) {
          sendJson(ws, log('error', 'Session already has an active prompt'))
          return
        }

        const wsSend = (outgoing: unknown) => sendJson(ws, outgoing)

        try {
          await handleChatPrompt({
            wsSend,
            session,
            prompt: payload.prompt,
            echo: args.echo,
            commands: args.commands,
            tools: args.tools,
            toolNames: args.toolNames,
            slashCommands: args.slashCommands,
          })
        } finally {
          sendSessionList(ws, {
            cwd: session.cwd,
            onError: message => sendJson(ws, log('error', message)),
          })
        }
      }

      if (payload.type === 'fs_read') {
        try {
          setOriginalCwd(session.cwd)
          await setCwd(session.cwd)
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
        return
      }

      if (payload.type === 'fs_write') {
        try {
          setOriginalCwd(session.cwd)
          await setCwd(session.cwd)
          grantReadPermissionForOriginalDir()

          const abs = resolveInProjectRoot(session.cwd, payload.path)

          const writeTool = args.tools.find(t => t.name === 'Write') ?? null
          if (writeTool) {
            const permission = await requestToolPermission({
              ws,
              session,
              tool: writeTool,
              input: { file_path: abs, content: payload.content },
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
        })
        if (permission.ok === false) {
          sendJson(ws, {
            type: 'git_checkout_result',
            ok: false,
            message: permission.message,
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
        })
        if (permission.ok === false) {
          sendJson(ws, {
            type: 'git_action_result',
            ok: false,
            action: 'stage',
            message: permission.message,
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
        sendJson(ws, { type: 'git_action_result', ok: true, action: 'stage' })
        return
      }

      if (payload.type === 'git_commit') {
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
        })
        if (permission.ok === false) {
          sendJson(ws, {
            type: 'git_commit_result',
            ok: false,
            message: permission.message,
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
        return
      }
    },

    close(ws: WsWithSession) {
      const session = ws.data.session
      session.ws = null
      try {
        session.activeAbortController?.abort()
      } catch {}
      for (const resolve of session.inflightPermissionRequests.values()) {
        try {
          resolve({
            decision: 'deny',
            rejectionMessage: 'Disconnected',
            updatedInput: null,
          })
        } catch {}
      }
      session.inflightPermissionRequests.clear()
      args.sessions.delete(session.sessionId)
    },
  }
}
