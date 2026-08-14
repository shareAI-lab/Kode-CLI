import { resolve } from 'node:path'

import { isUuid } from '@kode/runtime'

import {
  TaskControlService,
  type TaskControlFailure,
} from '../taskControlService'

type TaskRouteContext = {
  cwd: string
  taskService: TaskControlService
  listWorkspaces?: () => Promise<{
    workspaces: Array<{ id: string; path: string }>
    currentId: string
  }>
}

function responseForFailure(reason: TaskControlFailure): Response {
  if (reason === 'invalid_task_id') {
    return Response.json(
      { ok: false, error: 'Invalid task id' },
      { status: 400 },
    )
  }
  if (reason === 'not_attached') {
    return Response.json(
      { ok: false, error: 'Task is not attached to this daemon' },
      { status: 409 },
    )
  }
  // Do not disclose a task that belongs to another workspace or session.
  return Response.json({ ok: false, error: 'Task not found' }, { status: 404 })
}

function parseSessionId(
  url: URL,
): { ok: true; sessionId?: string } | { ok: false; response: Response } {
  const raw =
    url.searchParams.get('sessionId') ?? url.searchParams.get('session_id')
  if (raw === null || raw.trim() === '') return { ok: true }
  const sessionId = raw.trim()
  if (!isUuid(sessionId)) {
    return {
      ok: false,
      response: Response.json(
        { ok: false, error: 'Invalid session id' },
        { status: 400 },
      ),
    }
  }
  return { ok: true, sessionId }
}

function parseTailLines(
  url: URL,
): { ok: true; tailLines: number } | { ok: false; response: Response } {
  const raw = url.searchParams.get('tail')
  if (raw === null || raw.trim() === '') return { ok: true, tailLines: 200 }
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1000) {
    return {
      ok: false,
      response: Response.json(
        { ok: false, error: 'tail must be an integer between 1 and 1000' },
        { status: 400 },
      ),
    }
  }
  return { ok: true, tailLines: parsed }
}

export async function routeTask(
  req: Request,
  ctx: TaskRouteContext,
): Promise<Response | undefined> {
  const url = new URL(req.url)
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts[0] !== 'api' || parts[1] !== 'tasks') return undefined

  const cwd = await resolveTaskCwd(url, ctx)
  const session = parseSessionId(url)
  if (session.ok === false) return session.response
  const taskId = parts[2]?.trim() ?? ''
  const action = parts[3] ?? null

  if (!taskId) {
    if (req.method !== 'GET' || action) {
      return new Response('Method Not Allowed', { status: 405 })
    }
    return Response.json({
      tasks: ctx.taskService.list({
        cwd,
        ...(session.sessionId ? { sessionId: session.sessionId } : {}),
      }),
    })
  }

  if (action === 'output') {
    if (req.method !== 'GET')
      return new Response('Method Not Allowed', { status: 405 })
    const tail = parseTailLines(url)
    if (tail.ok === false) return tail.response
    const result = ctx.taskService.readOutput({
      cwd,
      taskId,
      ...(session.sessionId ? { sessionId: session.sessionId } : {}),
      tailLines: tail.tailLines,
    })
    if (result.ok === false) return responseForFailure(result.reason)
    return Response.json({
      task: result.value.task,
      content: result.value.content,
      tailLines: tail.tailLines,
    })
  }

  if (action === 'cancel') {
    if (req.method !== 'POST')
      return new Response('Method Not Allowed', { status: 405 })
    const result = ctx.taskService.cancel({
      cwd,
      taskId,
      ...(session.sessionId ? { sessionId: session.sessionId } : {}),
    })
    if (result.ok === false) return responseForFailure(result.reason)
    return Response.json(result.value)
  }

  if (action) return new Response('Not Found', { status: 404 })
  if (req.method !== 'GET')
    return new Response('Method Not Allowed', { status: 405 })

  const result = ctx.taskService.get({
    cwd,
    taskId,
    ...(session.sessionId ? { sessionId: session.sessionId } : {}),
  })
  if (result.ok === false) return responseForFailure(result.reason)
  return Response.json({ task: result.value })
}

async function resolveTaskCwd(
  url: URL,
  ctx: Pick<TaskRouteContext, 'cwd' | 'listWorkspaces'>,
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

export const __routeTaskForTests = {
  parseSessionId,
  parseTailLines,
  resolveTaskCwd,
}
