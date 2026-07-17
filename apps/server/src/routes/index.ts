import { basename, resolve } from 'node:path'

import type { Tool } from '@kode/core/tooling/Tool'
import type { WrappedClient } from '@kode/core/mcp/client'
import { isUuid } from '@kode/core/utils/uuid'
import { SUBAGENT_DISALLOWED_TOOL_NAMES } from '@kode/agent'

import { maybeServeWebui } from '../server/webui'
import { routeChat } from './chat'
import { routeGoalSchedules } from './goalSchedules'
import { routePermission } from './permission'
import { routeSession } from './session'
import { routeTask } from './task'
import { routeAgent } from './agent'
import { AgentControlService } from '../agentControlService'
import { PermissionControlService } from '../permissionControlService'
import { PersistentSessionService } from '../persistentSessionService'
import { TaskControlService } from '../taskControlService'
import type { WorkspaceInfo } from '../handlers/workspaces.handler'
import type { DaemonSession } from '../ws/types'
import type { SessionRegistry } from '../sessionRegistry'
import type { DaemonTurnGate } from '../turnGate'

type UpgradeServer<TData> = {
  upgrade: (req: Request, options: { data: TData }) => boolean
}

type WebSocketData = {
  session: DaemonSession
  replayHistory: boolean
  correlatedEvents: boolean
  afterSequence: number | null
}

export function createRoutes(args: {
  webuiRoot: string | null
  checkToken: (req: Request) => boolean
  listWorkspaces: () => Promise<{
    workspaces: WorkspaceInfo[]
    currentId: string
  }>
  sessionRegistry: SessionRegistry
  sessionService?: PersistentSessionService
  taskService?: TaskControlService
  permissionService?: PermissionControlService
  agentService?: AgentControlService
  turnGate: DaemonTurnGate
  cwd: string
  echo: boolean
  echoDelayMs: number
  commands: unknown[]
  tools: Tool[]
  toolNames: string[]
  slashCommands: string[]
  mcpClients: WrappedClient[]
}): {
  fetch: (
    req: Request,
    server: UpgradeServer<WebSocketData>,
  ) => Promise<Response | undefined>
} {
  const sessionService =
    args.sessionService ?? new PersistentSessionService(args.sessionRegistry)
  const taskService = args.taskService ?? new TaskControlService()
  const permissionService =
    args.permissionService ?? new PermissionControlService(args.sessionRegistry)
  const agentService =
    args.agentService ??
    new AgentControlService({
      listToolNames: () =>
        args.toolNames.filter(
          name => !SUBAGENT_DISALLOWED_TOOL_NAMES.has(name),
        ),
    })

  const resolveWorkspaceCwd = async (url: URL): Promise<string> => {
    const fallback = resolve(args.cwd)
    try {
      const { workspaces, currentId } = await args.listWorkspaces()
      const requested = url.searchParams.get('workspace')
      const selected =
        requested && workspaces.some(w => w.id === requested)
          ? requested
          : currentId
      return workspaces.find(w => w.id === selected)?.path ?? fallback
    } catch {
      return fallback
    }
  }

  return {
    async fetch(req, server) {
      const url = new URL(req.url)

      // Segment-based routes deliberately ignore empty path segments. Reject
      // non-canonical paths before their `/api/` token gate so `//api/...`
      // cannot be interpreted as an authenticated API request.
      if (url.pathname.includes('//')) {
        return new Response('Not Found', { status: 404 })
      }

      if (args.webuiRoot) {
        const response = maybeServeWebui({ webuiRoot: args.webuiRoot, url })
        if (response) return response
      }

      if (url.pathname === '/health') {
        return Response.json({
          ok: true,
          version: process.env.npm_package_version ?? null,
          pid: process.pid,
        })
      }

      if (url.pathname === '/api/health') {
        if (!args.checkToken(req))
          return new Response('Unauthorized', { status: 401 })
        return Response.json({
          ok: true,
          transport: 'daemon',
          version: process.env.npm_package_version ?? null,
          pid: process.pid,
          activeSessions: args.sessionRegistry.size,
        })
      }

      if (url.pathname.startsWith('/api/')) {
        if (!args.checkToken(req))
          return new Response('Unauthorized', { status: 401 })
      }

      if (url.pathname === '/api/workspaces') {
        try {
          const { workspaces, currentId } = await args.listWorkspaces()
          return Response.json({ workspaces, currentId })
        } catch (err) {
          const only = resolve(args.cwd)
          return Response.json(
            {
              workspaces: [
                {
                  id: only,
                  path: only,
                  title: basename(only) || only,
                  branch: null,
                  isCurrent: true,
                },
              ],
              currentId: only,
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 200 },
          )
        }
      }

      const chatResponse = await routeChat(req, {
        sessionRegistry: args.sessionRegistry,
        sessionService,
        turnGate: args.turnGate,
        resolveCwd: () => resolveWorkspaceCwd(url),
        echo: args.echo,
        echoDelayMs: args.echoDelayMs,
        commands: args.commands,
        tools: args.tools,
        toolNames: args.toolNames,
        slashCommands: args.slashCommands,
        mcpClients: args.mcpClients,
      })
      if (chatResponse) return chatResponse

      const sessionResponse = await routeSession(req, {
        cwd: args.cwd,
        listWorkspaces: args.listWorkspaces,
        sessionService,
        sessionRegistry: args.sessionRegistry,
      })
      if (sessionResponse) return sessionResponse

      const taskResponse = await routeTask(req, {
        cwd: args.cwd,
        listWorkspaces: args.listWorkspaces,
        taskService,
      })
      if (taskResponse) return taskResponse

      const goalSchedulesResponse = await routeGoalSchedules(req, {
        cwd: args.cwd,
        listWorkspaces: args.listWorkspaces,
      })
      if (goalSchedulesResponse) return goalSchedulesResponse

      const permissionResponse = await routePermission(req, {
        cwd: args.cwd,
        listWorkspaces: args.listWorkspaces,
        permissionService,
      })
      if (permissionResponse) return permissionResponse

      const agentResponse = await routeAgent(req, {
        cwd: args.cwd,
        listWorkspaces: args.listWorkspaces,
        agentService,
      })
      if (agentResponse) return agentResponse

      if (url.pathname === '/ws') {
        if (!args.checkToken(req))
          return new Response('Unauthorized', { status: 401 })
        const selectedCwd = await resolveWorkspaceCwd(url)

        const requestedSessionId =
          url.searchParams.get('session_id') ??
          url.searchParams.get('sessionId') ??
          ''
        const freshSession = ['1', 'true'].includes(
          url.searchParams.get('fresh_session')?.trim().toLowerCase() ?? '',
        )
        const correlatedEvents =
          url.searchParams.get('correlatedEvents') === '1'
        const afterSequenceRaw = url.searchParams.get('afterSequence')
        const afterSequence =
          afterSequenceRaw === null || afterSequenceRaw.trim() === ''
            ? null
            : Number(afterSequenceRaw)
        if (
          afterSequence !== null &&
          (!Number.isSafeInteger(afterSequence) || afterSequence < 0)
        ) {
          return new Response('Invalid afterSequence', { status: 400 })
        }
        if (afterSequence !== null && !correlatedEvents) {
          return new Response('afterSequence requires correlatedEvents=1', {
            status: 400,
          })
        }
        let session: DaemonSession
        let replayHistory = false
        let removeOnUpgradeFailure = false
        if (requestedSessionId && !freshSession) {
          if (!isUuid(requestedSessionId)) {
            return new Response('Invalid session id', { status: 400 })
          }
          const found = args.sessionRegistry.getOrLoad({
            cwd: selectedCwd,
            sessionId: requestedSessionId,
          })
          if (found.ok === false) {
            if (found.reason === 'metadata_invalid') {
              return new Response('Session metadata is invalid', {
                status: 500,
              })
            }
            if (found.reason === 'archived') {
              return new Response('Session archived', { status: 410 })
            }
            return new Response(
              found.reason === 'cwd_mismatch'
                ? 'Session workspace mismatch'
                : 'Unknown session',
              { status: found.reason === 'cwd_mismatch' ? 409 : 404 },
            )
          }
          session = found.session
          replayHistory = true
          removeOnUpgradeFailure = found.restored
        } else {
          session = args.sessionRegistry.create(selectedCwd)
          removeOnUpgradeFailure = true
        }

        let ok = false
        try {
          ok = server.upgrade(req, {
            data: { session, replayHistory, correlatedEvents, afterSequence },
          })
        } finally {
          if (!ok && removeOnUpgradeFailure) {
            args.sessionRegistry.deleteIfIdle(session)
          }
        }
        return ok ? undefined : new Response('Upgrade failed', { status: 400 })
      }

      return new Response('Not found', { status: 404 })
    },
  }
}
