import { resolve } from 'node:path'

import { isUuid } from '@kode/runtime'
import { kodeMessageToSdkMessage } from '#protocol/utils/kodeAgentStreamJson'

import { sendSessionList } from '../handlers/session.handler'
import {
  PersistentSessionService,
  type PersistentSessionFailure,
} from '../persistentSessionService'
import type { SessionRegistry } from '../sessionRegistry'

type SessionRouteContext = {
  cwd: string
  sessionService: PersistentSessionService
  sessionRegistry: SessionRegistry
  listWorkspaces?: () => Promise<{
    workspaces: Array<{ id: string; path: string }>
    currentId: string
  }>
}

type SessionMetadataPatch = {
  customTitle?: string | null
  tag?: string | null
  summary?: string | null
  archived?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseNullableText(
  value: unknown,
  field: string,
): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${field}`)
  }
  return value.trim() || null
}

function parseMetadataPatch(body: unknown): SessionMetadataPatch {
  if (!isRecord(body)) throw new Error('Invalid request body')
  const patch: SessionMetadataPatch = {
    customTitle: parseNullableText(body.customTitle, 'customTitle'),
    tag: parseNullableText(body.tag, 'tag'),
    summary: parseNullableText(body.summary, 'summary'),
  }
  if (body.archived !== undefined) {
    if (typeof body.archived !== 'boolean') throw new Error('Invalid archived')
    patch.archived = body.archived
  }
  if (
    patch.customTitle === undefined &&
    patch.tag === undefined &&
    patch.summary === undefined &&
    patch.archived === undefined
  ) {
    throw new Error('No valid updates provided')
  }
  return patch
}

function responseForFailure(reason: PersistentSessionFailure): Response {
  if (reason === 'active') {
    return Response.json(
      { ok: false, error: 'Session is active' },
      { status: 409 },
    )
  }
  if (reason === 'archived') {
    return Response.json(
      { ok: false, error: 'Session is archived' },
      { status: 410 },
    )
  }
  if (reason === 'invalid_cutoff') {
    return Response.json(
      { ok: false, error: 'beforeUuid not found in source session' },
      { status: 400 },
    )
  }
  if (reason === 'invalid_metadata') {
    return Response.json(
      { ok: false, error: 'Invalid session metadata' },
      { status: 400 },
    )
  }
  if (reason === 'already_exists') {
    return Response.json(
      { ok: false, error: 'Target session already exists' },
      { status: 409 },
    )
  }
  if (reason === 'metadata_invalid') {
    return Response.json(
      { ok: false, error: 'Session metadata is invalid' },
      { status: 500 },
    )
  }
  if (reason === 'persistence_failed') {
    return Response.json(
      { ok: false, error: 'Failed to persist session' },
      { status: 500 },
    )
  }

  // Do not disclose a session that belongs to a different workspace.
  return Response.json(
    { ok: false, error: 'Session not found' },
    { status: 404 },
  )
}

function broadcastSessionListForWorkspace(args: {
  service: PersistentSessionService
  sessionRegistry: SessionRegistry
  cwd: string
}): void {
  const sent = new Set<unknown>()
  const listSessions = () => args.service.list({ cwd: args.cwd })
  for (const runtime of args.sessionRegistry.listForCwd(args.cwd)) {
    for (const client of Array.from(runtime.clients)) {
      if (sent.has(client)) continue
      sent.add(client)
      sendSessionList(client, { cwd: args.cwd, listSessions })
    }
  }
}

export async function routeSession(
  req: Request,
  ctx: SessionRouteContext,
): Promise<Response | undefined> {
  const url = new URL(req.url)
  const pathParts = url.pathname.split('/').filter(Boolean)
  if (pathParts[0] !== 'api' || pathParts[1] !== 'sessions') {
    return undefined
  }

  const cwd = await resolveSessionCwd(url, ctx)
  const requestedId = pathParts[2]?.trim() ?? ''
  const action = pathParts[3] ?? null

  if (!requestedId) {
    if (req.method !== 'GET' || action) {
      return new Response('Method Not Allowed', { status: 405 })
    }
    const includeArchived = ['1', 'true'].includes(
      url.searchParams.get('includeArchived')?.trim().toLowerCase() ?? '',
    )
    return Response.json({
      sessions: ctx.sessionService.list({ cwd, includeArchived }),
    })
  }

  if (!isUuid(requestedId)) {
    return Response.json(
      { ok: false, error: 'Invalid session id' },
      { status: 400 },
    )
  }

  if (action === 'fork') {
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
        { ok: false, error: 'Invalid request body' },
        { status: 400 },
      )
    }

    const newSessionId =
      typeof body.newSessionId === 'string' ? body.newSessionId.trim() : ''
    if (newSessionId && !isUuid(newSessionId)) {
      return Response.json(
        { ok: false, error: 'Invalid newSessionId' },
        { status: 400 },
      )
    }
    const beforeUuid =
      typeof body.beforeUuid === 'string' ? body.beforeUuid.trim() : ''
    if (body.beforeUuid !== undefined && !beforeUuid) {
      return Response.json(
        { ok: false, error: 'Invalid beforeUuid' },
        { status: 400 },
      )
    }
    if (
      body.includeUuid !== undefined &&
      typeof body.includeUuid !== 'boolean'
    ) {
      return Response.json(
        { ok: false, error: 'Invalid includeUuid' },
        { status: 400 },
      )
    }

    let metadata: Pick<SessionMetadataPatch, 'customTitle' | 'tag' | 'summary'>
    try {
      metadata = {
        customTitle: parseNullableText(body.customTitle, 'customTitle'),
        tag: parseNullableText(body.tag, 'tag'),
        summary: parseNullableText(body.summary, 'summary'),
      }
    } catch (error) {
      return Response.json(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        { status: 400 },
      )
    }

    const result = ctx.sessionService.fork({
      cwd,
      sessionId: requestedId,
      ...(newSessionId ? { newSessionId } : {}),
      ...(beforeUuid ? { beforeUuid } : {}),
      ...(typeof body.includeUuid === 'boolean'
        ? { includeUuid: body.includeUuid }
        : {}),
      ...metadata,
    })
    if (result.ok === false) return responseForFailure(result.reason)

    broadcastSessionListForWorkspace({
      service: ctx.sessionService,
      sessionRegistry: ctx.sessionRegistry,
      cwd,
    })
    return Response.json({
      ok: true,
      sessionId: result.detail.session.sessionId,
      session: result.detail.session,
    })
  }

  if (action) return new Response('Not Found', { status: 404 })

  if (req.method === 'GET') {
    const result = ctx.sessionService.resolve({
      cwd,
      sessionId: requestedId,
    })
    if (result.ok === false) return responseForFailure(result.reason)

    const events = result.detail.messages
      .map(message =>
        kodeMessageToSdkMessage(message, result.detail.session.sessionId),
      )
      .filter((event): event is NonNullable<typeof event> => Boolean(event))
    return Response.json({ ...result.detail.session, events })
  }

  if (req.method === 'PATCH') {
    let body: unknown
    try {
      body = await req.json()
    } catch {
      body = null
    }

    let patch: SessionMetadataPatch
    try {
      patch = parseMetadataPatch(body)
    } catch (error) {
      return Response.json(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        { status: 400 },
      )
    }

    const result = ctx.sessionService.updateMetadata({
      cwd,
      sessionId: requestedId,
      patch,
    })
    if (result.ok === false) return responseForFailure(result.reason)
    broadcastSessionListForWorkspace({
      service: ctx.sessionService,
      sessionRegistry: ctx.sessionRegistry,
      cwd,
    })
    return Response.json({ ok: true, session: result.detail.session })
  }

  if (req.method === 'DELETE') {
    const result = ctx.sessionService.archive({
      cwd,
      sessionId: requestedId,
    })
    if (result.ok === false) {
      if (result.reason === 'not_found') {
        return Response.json({
          ok: true,
          archived: false,
          alreadyMissing: true,
        })
      }
      return responseForFailure(result.reason)
    }
    broadcastSessionListForWorkspace({
      service: ctx.sessionService,
      sessionRegistry: ctx.sessionRegistry,
      cwd,
    })
    return Response.json({
      ok: true,
      archived: true,
      session: result.detail.session,
    })
  }

  return new Response('Method Not Allowed', { status: 405 })
}

async function resolveSessionCwd(
  url: URL,
  ctx: Pick<SessionRouteContext, 'cwd' | 'listWorkspaces'>,
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

export const __routeSessionForTests = {
  parseMetadataPatch,
  resolveSessionCwd,
}
