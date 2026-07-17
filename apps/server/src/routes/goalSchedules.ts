import { resolve } from 'node:path'

import {
  GoalService,
  type ControlPlaneGoalScheduleAction,
  type Goal,
} from '@kode/core/goals'
import { isUuid } from '@kode/core/utils/uuid'

export type GoalScheduleSummary = {
  id: string
  goalId: string
  kind: 'once' | 'interval'
  status: Goal['status']
  revision: number
  nextRunAt: number | null
  createdAt: number
  updatedAt: number
  objective: string
  runAt?: number
  everyMs?: number
  anchorAt?: number
}

type GoalScheduleRouteContext = {
  cwd: string
  goalService?: Pick<
    GoalService,
    | 'listGoals'
    | 'createScheduledForControlPlane'
    | 'transitionScheduleForControlPlane'
  >
  listWorkspaces?: () => Promise<{
    workspaces: Array<{ id: string; path: string }>
    currentId: string
  }>
  maxSchedules?: number
}

const MAX_ACTION_REQUEST_BYTES = 8 * 1024
const MAX_CREATE_REQUEST_BYTES = 16 * 1024
const MAX_ACTION_REASON_CHARS = 1_000
const MAX_OBJECTIVE_CHARS = 4_000

function parseSessionId(
  url: URL,
  options: { required?: boolean } = {},
): { ok: true; sessionId?: string } | { ok: false; response: Response } {
  const raw =
    url.searchParams.get('sessionId') ?? url.searchParams.get('session_id')
  if (raw === null || raw.trim() === '') {
    if (options.required) {
      return {
        ok: false,
        response: Response.json(
          { ok: false, error: 'sessionId is required' },
          { status: 400 },
        ),
      }
    }
    return { ok: true }
  }
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

export function toGoalScheduleSummary(goal: Goal): GoalScheduleSummary {
  const schedule = goal.schedule
  return {
    id: schedule.id,
    goalId: goal.id,
    kind: schedule.kind,
    status: goal.status,
    revision: goal.revision,
    nextRunAt: schedule.nextRunAt,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    objective: goal.objective,
    ...(schedule.kind === 'once' ? { runAt: schedule.runAt } : {}),
    ...(schedule.kind === 'interval'
      ? { everyMs: schedule.everyMs, anchorAt: schedule.anchorAt }
      : {}),
  }
}

function responseForTransitionFailure(
  reason:
    | 'not_found'
    | 'revision_conflict'
    | 'active_run'
    | 'invalid_state'
    | 'invalid_request',
): Response {
  if (reason === 'invalid_request') {
    return Response.json({ ok: false, error: 'Invalid request' }, { status: 400 })
  }
  if (reason === 'revision_conflict') {
    return Response.json(
      { ok: false, error: 'Revision conflict' },
      { status: 409 },
    )
  }
  if (reason === 'active_run') {
    return Response.json(
      { ok: false, error: 'Schedule has an active run' },
      { status: 409 },
    )
  }
  if (reason === 'invalid_state') {
    return Response.json(
      { ok: false, error: 'Invalid schedule state for action' },
      { status: 409 },
    )
  }
  return Response.json({ ok: false, error: 'Schedule not found' }, { status: 404 })
}

async function readJsonObject(
  req: Request,
  maxBytes: number,
): Promise<
  { ok: true; value: Record<string, unknown> } | { ok: false; response: Response }
> {
  const raw = await req.text()
  if (raw.length > maxBytes) {
    return {
      ok: false,
      response: Response.json(
        { ok: false, error: 'Request body too large' },
        { status: 413 },
      ),
    }
  }
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        ok: false,
        response: Response.json(
          { ok: false, error: 'JSON object body required' },
          { status: 400 },
        ),
      }
    }
    return { ok: true, value: parsed as Record<string, unknown> }
  } catch {
    return {
      ok: false,
      response: Response.json(
        { ok: false, error: 'Invalid JSON body' },
        { status: 400 },
      ),
    }
  }
}

/**
 * Goal schedule control plane:
 * - GET  /api/goal-schedules — list (optional session filter)
 * - POST /api/goal-schedules — create scheduled goal (body: sessionId, objective, schedule)
 * - POST /api/goal-schedules/:scheduleId/actions — pause|resume|cancel
 */
export async function routeGoalSchedules(
  req: Request,
  ctx: GoalScheduleRouteContext,
): Promise<Response | undefined> {
  const url = new URL(req.url)
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts[0] !== 'api' || parts[1] !== 'goal-schedules') return undefined

  const service =
    ctx.goalService ??
    (new GoalService() as GoalScheduleRouteContext['goalService'] & GoalService)
  const cwd = await resolveScheduleCwd(url, ctx)
  const scheduleId = parts[2]?.trim() ?? ''
  const actionSegment = parts[3] ?? null

  if (!scheduleId) {
    if (req.method === 'GET') {
      const session = parseSessionId(url)
      if (session.ok === false) return session.response
      const maxSchedules = Math.max(
        1,
        Math.min(500, Math.floor(ctx.maxSchedules ?? 200)),
      )
      const schedules = service
        .listGoals()
        .filter(goal => {
          if (goal.cwd !== cwd) return false
          if (session.sessionId && goal.sessionId !== session.sessionId) {
            return false
          }
          return true
        })
        .sort((a, b) => b.updatedAt - a.updatedAt || b.revision - a.revision)
        .slice(0, maxSchedules)
        .map(toGoalScheduleSummary)
      return Response.json({ schedules })
    }

    if (req.method === 'POST') {
      const body = await readJsonObject(req, MAX_CREATE_REQUEST_BYTES)
      if (body.ok === false) return body.response
      const sessionIdRaw = body.value.sessionId
      if (typeof sessionIdRaw !== 'string' || !isUuid(sessionIdRaw.trim())) {
        return Response.json(
          { ok: false, error: 'Valid sessionId is required' },
          { status: 400 },
        )
      }
      const objectiveRaw = body.value.objective
      if (typeof objectiveRaw !== 'string' || !objectiveRaw.trim()) {
        return Response.json(
          { ok: false, error: 'objective is required' },
          { status: 400 },
        )
      }
      const objective = objectiveRaw.trim().slice(0, MAX_OBJECTIVE_CHARS)
      const scheduleRaw = body.value.schedule
      if (
        !scheduleRaw ||
        typeof scheduleRaw !== 'object' ||
        Array.isArray(scheduleRaw)
      ) {
        return Response.json(
          { ok: false, error: 'schedule object is required' },
          { status: 400 },
        )
      }
      const scheduleRecord = scheduleRaw as Record<string, unknown>
      const kind = scheduleRecord.kind
      if (kind !== 'once' && kind !== 'interval') {
        return Response.json(
          { ok: false, error: 'schedule.kind must be once or interval' },
          { status: 400 },
        )
      }
      const schedule =
        kind === 'once'
          ? {
              kind: 'once' as const,
              ...(typeof scheduleRecord.runAt === 'number' &&
              Number.isFinite(scheduleRecord.runAt)
                ? { runAt: Math.floor(scheduleRecord.runAt) }
                : {}),
            }
          : {
              kind: 'interval' as const,
              everyMs: Math.floor(Number(scheduleRecord.everyMs)),
              ...(typeof scheduleRecord.anchorAt === 'number' &&
              Number.isFinite(scheduleRecord.anchorAt)
                ? { anchorAt: Math.floor(scheduleRecord.anchorAt) }
                : {}),
            }
      if (
        schedule.kind === 'interval' &&
        (!Number.isFinite(schedule.everyMs) || schedule.everyMs <= 0)
      ) {
        return Response.json(
          { ok: false, error: 'schedule.everyMs must be a positive number' },
          { status: 400 },
        )
      }

      const created = service.createScheduledForControlPlane({
        cwd,
        sessionId: sessionIdRaw.trim(),
        objective,
        schedule,
      })
      if (!created) {
        return Response.json(
          {
            ok: false,
            error: 'An active goal already exists for this session',
          },
          { status: 409 },
        )
      }
      return Response.json(
        { ok: true, schedule: toGoalScheduleSummary(created) },
        { status: 201 },
      )
    }

    return new Response('Method Not Allowed', { status: 405 })
  }

  if (actionSegment === 'actions') {
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 })
    }
    const body = await readJsonObject(req, MAX_ACTION_REQUEST_BYTES)
    if (body.ok === false) return body.response

    const sessionIdRaw = body.value.sessionId
    if (typeof sessionIdRaw !== 'string' || !isUuid(sessionIdRaw.trim())) {
      return Response.json(
        { ok: false, error: 'Valid sessionId is required' },
        { status: 400 },
      )
    }
    const expectedRevision = body.value.expectedRevision
    if (
      typeof expectedRevision !== 'number' ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 1
    ) {
      return Response.json(
        { ok: false, error: 'expectedRevision must be a positive integer' },
        { status: 400 },
      )
    }
    const action = body.value.action
    if (action !== 'pause' && action !== 'resume' && action !== 'cancel') {
      return Response.json(
        { ok: false, error: 'action must be pause, resume, or cancel' },
        { status: 400 },
      )
    }
    const reasonRaw = body.value.reason
    const reason =
      typeof reasonRaw === 'string'
        ? reasonRaw.trim().slice(0, MAX_ACTION_REASON_CHARS)
        : undefined

    const result = service.transitionScheduleForControlPlane({
      cwd,
      sessionId: sessionIdRaw.trim(),
      scheduleId,
      expectedRevision,
      action: action as ControlPlaneGoalScheduleAction,
      ...(reason ? { reason } : {}),
    })
    if (result.ok === false) return responseForTransitionFailure(result.reason)
    return Response.json({
      ok: true,
      schedule: toGoalScheduleSummary(result.goal),
    })
  }

  if (actionSegment) return new Response('Not Found', { status: 404 })
  return new Response('Not Found', { status: 404 })
}

async function resolveScheduleCwd(
  url: URL,
  ctx: Pick<GoalScheduleRouteContext, 'cwd' | 'listWorkspaces'>,
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

export const __goalSchedulesForTests = {
  parseSessionId,
  resolveScheduleCwd,
  toGoalScheduleSummary,
}
