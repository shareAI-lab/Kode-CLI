import { resolve } from 'node:path'

import { isUuid } from '@kode/runtime'
import { DaemonPermissionUpdateSchema } from '@kode/protocol'

import {
  PermissionControlService,
  type PermissionControlFailure,
} from '../permissionControlService'

type PermissionRouteContext = {
  cwd: string
  permissionService: PermissionControlService
  listWorkspaces?: () => Promise<{
    workspaces: Array<{ id: string; path: string }>
    currentId: string
  }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function responseForFailure(reason: PermissionControlFailure): Response {
  if (reason === 'session_required') {
    return Response.json(
      { ok: false, error: 'A live session is required for this update' },
      { status: 400 },
    )
  }
  if (reason === 'persistence_failed') {
    return Response.json(
      { ok: false, error: 'Failed to persist permission update' },
      { status: 500 },
    )
  }
  if (
    reason === 'policy_locked' ||
    reason === 'unsupported_destination' ||
    reason === 'bypass_unavailable'
  ) {
    return Response.json(
      { ok: false, error: 'Permission update is not allowed by policy' },
      { status: 403 },
    )
  }
  // A cross-workspace session must remain indistinguishable from an unknown id.
  return Response.json(
    { ok: false, error: 'Session not found' },
    { status: 404 },
  )
}

function parseOptionalSessionId(
  value: unknown,
): { ok: true; sessionId?: string } | { ok: false; response: Response } {
  if (value === undefined || value === null || value === '') return { ok: true }
  if (typeof value !== 'string' || !isUuid(value.trim())) {
    return {
      ok: false,
      response: Response.json(
        { ok: false, error: 'Invalid session id' },
        { status: 400 },
      ),
    }
  }
  return { ok: true, sessionId: value.trim() }
}

export async function routePermission(
  req: Request,
  ctx: PermissionRouteContext,
): Promise<Response | undefined> {
  const url = new URL(req.url)
  if (url.pathname !== '/api/permissions') return undefined
  const cwd = await resolvePermissionCwd(url, ctx)

  if (req.method === 'GET') {
    const session = parseOptionalSessionId(url.searchParams.get('sessionId'))
    if (session.ok === false) return session.response
    const result = ctx.permissionService.get({
      cwd,
      ...(session.sessionId ? { sessionId: session.sessionId } : {}),
    })
    if (result.ok === false) return responseForFailure(result.reason)
    return Response.json({ permission: result.value })
  }

  if (req.method !== 'PATCH')
    return new Response('Method Not Allowed', { status: 405 })
  let body: unknown
  try {
    body = await req.json()
  } catch {
    body = null
  }
  if (!isRecord(body)) {
    return Response.json(
      { ok: false, error: 'Invalid request body' },
      { status: 400 },
    )
  }
  const session = parseOptionalSessionId(body.sessionId)
  if (session.ok === false) return session.response
  const update = DaemonPermissionUpdateSchema.safeParse(body.update)
  if (!update.success) {
    return Response.json(
      { ok: false, error: 'Invalid permission update' },
      { status: 400 },
    )
  }

  const result = ctx.permissionService.update({
    cwd,
    ...(session.sessionId ? { sessionId: session.sessionId } : {}),
    update: update.data as import('@kode/protocol').DaemonPermissionUpdate,
  })
  if (result.ok === false) return responseForFailure(result.reason)
  return Response.json(result.value)
}

async function resolvePermissionCwd(
  url: URL,
  ctx: Pick<PermissionRouteContext, 'cwd' | 'listWorkspaces'>,
): Promise<string> {
  const fallback = resolve(ctx.cwd)
  const requested = url.searchParams.get('workspace')
  if (!ctx.listWorkspaces || !requested) return fallback
  try {
    const { workspaces, currentId } = await ctx.listWorkspaces()
    const selected =
      workspaces.find(workspace => workspace.id === requested) ??
      workspaces.find(workspace => workspace.id === currentId) ??
      null
    return selected?.path ? resolve(selected.path) : fallback
  } catch {
    return fallback
  }
}

export const __routePermissionForTests = {
  parseOptionalSessionId,
  resolvePermissionCwd,
}
