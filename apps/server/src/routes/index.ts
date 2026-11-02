import { basename, resolve } from 'node:path'

import { loadToolPermissionContextFromDisk } from '@kode/core/utils/permissions/toolPermissionSettings'
import type { Tool } from '@kode/core/tooling/Tool'
import { SettingsFileError } from '@kode/config'

import { maybeServeWebui } from '../server/webui'
import { routeChat } from './chat'
import { routeSession } from './session'
import type { WorkspaceInfo } from '../handlers/workspaces.handler'
import type { DaemonSession } from '../ws/types'

type UpgradeServer<TData> = {
  upgrade: (req: Request, options: { data: TData }) => boolean
}

export function createRoutes(args: {
  webuiRoot: string | null
  checkToken: (req: Request) => boolean
  listWorkspaces: () => Promise<{
    workspaces: WorkspaceInfo[]
    currentId: string
  }>
  sessions: Map<string, DaemonSession>
  cwd: string
  echo: boolean
  commands: unknown[]
  tools: Tool[]
  toolNames: string[]
  slashCommands: string[]
}): {
  fetch: (
    req: Request,
    server: UpgradeServer<{ session: DaemonSession }>,
  ) => Promise<Response | undefined>
} {
  return {
    async fetch(req, server) {
      const url = new URL(req.url)

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
        return Response.json({ ok: true })
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
        sessions: args.sessions,
        echo: args.echo,
        commands: args.commands,
        tools: args.tools,
        toolNames: args.toolNames,
        slashCommands: args.slashCommands,
      })
      if (chatResponse) return chatResponse

      const sessionResponse = await routeSession(req, { cwd: args.cwd })
      if (sessionResponse) return sessionResponse

      if (url.pathname === '/ws') {
        if (!args.checkToken(req))
          return new Response('Unauthorized', { status: 401 })
        const { workspaces, currentId } = await args.listWorkspaces()
        const requested = url.searchParams.get('workspace')
        const selected =
          requested && workspaces.some(w => w.id === requested)
            ? requested
            : currentId
        const selectedCwd =
          workspaces.find(w => w.id === selected)?.path ?? resolve(args.cwd)

        let toolPermissionContext
        try {
          toolPermissionContext = loadToolPermissionContextFromDisk({
            projectDir: selectedCwd,
            includeKodeProjectConfig: true,
            isBypassPermissionsModeAvailable: true,
          })
        } catch (error) {
          if (!(error instanceof SettingsFileError)) throw error
          return Response.json({ error: error.message }, { status: 500 })
        }

        const sessionId = crypto.randomUUID()
        const session: DaemonSession = {
          sessionId,
          cwd: selectedCwd,
          ws: null,
          messages: [],
          readFileTimestamps: {},
          responseState: {},
          toolPermissionContext,
          activeAbortController: null,
          inflightPermissionRequests: new Map(),
        }
        args.sessions.set(sessionId, session)

        const ok = server.upgrade(req, { data: { session } })
        return ok ? undefined : new Response('Upgrade failed', { status: 400 })
      }

      return new Response('Not found', { status: 404 })
    },
  }
}
