import { resolve } from 'node:path'

import {
  GoalService,
  MAX_GOAL_ACCEPTANCE_CRITERIA,
  MAX_GOAL_CONTINUATIONS,
  MAX_GOAL_CRITERION_CHARS,
  MAX_GOAL_OBJECTIVE_CHARS,
  type ControlPlaneGoalScheduleAction,
  type ControlPlaneGoalScheduleInput,
  type Goal,
  type GoalEvent,
} from '@kode/goals'
import { isUuid } from '@kode/runtime'

export type GoalScheduleSummary = {
  id: string
  goalId: string
  kind: 'once' | 'interval'
  status: Goal['status']
  revision: number
  nextRunAt: number | null
  retryAt: number | null
  createdAt: number
  updatedAt: number
  objective: string
  acceptanceCriteria: string[]
  maxIterations: number
  turnCount: number | null
  pausedReason: string | null
  lastError: Goal['lastError'] | null
  lastClaimedAt: number | null
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
    | 'updateScheduleForControlPlane'
    | 'listScheduleEventsForControlPlane'
  >
  listWorkspaces?: () => Promise<{
    workspaces: Array<{ id: string; path: string }>
    currentId: string
  }>
  sessionExists: (args: {
    cwd: string
    sessionId: string
  }) => boolean | Promise<boolean>
  maxSchedules?: number
}

const MAX_ACTION_REQUEST_BYTES = 8 * 1024
// The public field contract permits 32 x 1,000-character criteria plus a
// 4,000-character objective. Keep the transport cap aligned with that valid
// payload instead of rejecting otherwise legal definitions.
const MAX_DEFINITION_REQUEST_BYTES = 192 * 1024
const MAX_ACTION_REASON_CHARS = 1_000
const MIN_CONTROL_PLANE_INTERVAL_MS = 1_000
const DEFAULT_EVENT_LIMIT = 40
const MAX_EVENT_LIMIT = 100

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
    retryAt: schedule.retryAt ?? null,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    objective: goal.objective,
    acceptanceCriteria: [...goal.acceptanceCriteria],
    maxIterations: goal.loop.maxIterations,
    turnCount: goal.activeRun?.turnCount ?? null,
    pausedReason: goal.pausedReason ?? null,
    lastError: goal.lastError ? { ...goal.lastError } : null,
    lastClaimedAt: schedule.lastClaimedAt ?? null,
    ...(schedule.kind === 'once' ? { runAt: schedule.runAt } : {}),
    ...(schedule.kind === 'interval'
      ? { everyMs: schedule.everyMs, anchorAt: schedule.anchorAt }
      : {}),
  }
}

export type GoalScheduleEventSummary = Pick<
  GoalEvent,
  'id' | 'goalId' | 'type' | 'at' | 'revision' | 'from' | 'to' | 'message'
>

function toGoalScheduleEventSummary(
  event: GoalEvent,
): GoalScheduleEventSummary {
  return {
    id: event.id,
    goalId: event.goalId,
    type: event.type,
    at: event.at,
    revision: event.revision,
    ...(event.from ? { from: event.from } : {}),
    ...(event.to ? { to: event.to } : {}),
    ...(event.message ? { message: event.message } : {}),
  }
}

function parseExpectedRevision(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
    ? value
    : null
}

function parseAcceptanceCriteriaField(
  value: unknown,
): { ok: true; value: string[] } | { ok: false; response: Response } {
  if (
    !Array.isArray(value) ||
    value.length > MAX_GOAL_ACCEPTANCE_CRITERIA ||
    value.some(
      criterion =>
        typeof criterion !== 'string' ||
        !criterion.trim() ||
        criterion.trim().length > MAX_GOAL_CRITERION_CHARS,
    )
  ) {
    return {
      ok: false,
      response: Response.json(
        {
          ok: false,
          error: `acceptanceCriteria must contain at most ${MAX_GOAL_ACCEPTANCE_CRITERIA} non-empty strings of at most ${MAX_GOAL_CRITERION_CHARS} characters`,
        },
        { status: 400 },
      ),
    }
  }
  return {
    ok: true,
    value: value.map(criterion => String(criterion).trim()),
  }
}

function parseMaxIterationsField(
  value: unknown,
): { ok: true; value: number } | { ok: false; response: Response } {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_GOAL_CONTINUATIONS
  ) {
    return {
      ok: false,
      response: Response.json(
        {
          ok: false,
          error: `maxIterations must be an integer between 1 and ${MAX_GOAL_CONTINUATIONS}`,
        },
        { status: 400 },
      ),
    }
  }
  return { ok: true, value }
}

function parseScheduleField(
  value: unknown,
):
  | { ok: true; value: ControlPlaneGoalScheduleInput }
  | { ok: false; response: Response } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      ok: false,
      response: Response.json(
        { ok: false, error: 'schedule object is required' },
        { status: 400 },
      ),
    }
  }
  const schedule = value as Record<string, unknown>
  if (schedule.kind === 'once') {
    if (
      schedule.runAt !== undefined &&
      (!Number.isSafeInteger(schedule.runAt) || (schedule.runAt as number) < 0)
    ) {
      return {
        ok: false,
        response: Response.json(
          { ok: false, error: 'schedule.runAt must be a safe integer' },
          { status: 400 },
        ),
      }
    }
    return {
      ok: true,
      value: {
        kind: 'once',
        ...(typeof schedule.runAt === 'number'
          ? { runAt: schedule.runAt }
          : {}),
      },
    }
  }
  if (schedule.kind === 'interval') {
    if (
      schedule.anchorAt !== undefined &&
      (!Number.isSafeInteger(schedule.anchorAt) ||
        (schedule.anchorAt as number) < 0)
    ) {
      return {
        ok: false,
        response: Response.json(
          { ok: false, error: 'schedule.anchorAt must be a safe integer' },
          { status: 400 },
        ),
      }
    }
    if (
      !Number.isSafeInteger(schedule.everyMs) ||
      (schedule.everyMs as number) < MIN_CONTROL_PLANE_INTERVAL_MS
    ) {
      return {
        ok: false,
        response: Response.json(
          {
            ok: false,
            error: `schedule.everyMs must be an integer of at least ${MIN_CONTROL_PLANE_INTERVAL_MS}`,
          },
          { status: 400 },
        ),
      }
    }
    return {
      ok: true,
      value: {
        kind: 'interval',
        everyMs: schedule.everyMs as number,
        ...(typeof schedule.anchorAt === 'number'
          ? { anchorAt: schedule.anchorAt }
          : {}),
      },
    }
  }
  return {
    ok: false,
    response: Response.json(
      { ok: false, error: 'schedule.kind must be once or interval' },
      { status: 400 },
    ),
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
    return Response.json(
      { ok: false, error: 'Invalid request' },
      { status: 400 },
    )
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
  return Response.json(
    { ok: false, error: 'Schedule not found' },
    { status: 404 },
  )
}

async function readJsonObject(
  req: Request,
  maxBytes: number,
): Promise<
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; response: Response }
> {
  const tooLarge = () =>
    Response.json(
      { ok: false, error: 'Request body too large' },
      { status: 413 },
    )
  const declaredLength = req.headers.get('content-length')
  if (
    declaredLength &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > maxBytes
  ) {
    return { ok: false, response: tooLarge() }
  }

  const reader = req.body?.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        totalBytes += value.byteLength
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => undefined)
          return { ok: false, response: tooLarge() }
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
  }
  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  let raw: string
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return {
      ok: false,
      response: Response.json(
        { ok: false, error: 'Request body must be valid UTF-8' },
        { status: 400 },
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
 * - PATCH /api/goal-schedules/:scheduleId — edit an idle definition
 * - GET  /api/goal-schedules/:scheduleId/events — bounded event history
 * - POST /api/goal-schedules/:scheduleId/actions — pause|resume|retry|run_now|cancel
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
      const body = await readJsonObject(req, MAX_DEFINITION_REQUEST_BYTES)
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
      const objective = objectiveRaw.trim()
      if (objective.length > MAX_GOAL_OBJECTIVE_CHARS) {
        return Response.json(
          {
            ok: false,
            error: `objective cannot exceed ${MAX_GOAL_OBJECTIVE_CHARS} characters`,
          },
          { status: 400 },
        )
      }
      const criteriaRaw = body.value.acceptanceCriteria
      let acceptanceCriteria: string[] = []
      if (criteriaRaw !== undefined) {
        const parsedCriteria = parseAcceptanceCriteriaField(criteriaRaw)
        if (parsedCriteria.ok === false) return parsedCriteria.response
        acceptanceCriteria = parsedCriteria.value
      }
      let maxIterations: number | undefined
      if (body.value.maxIterations !== undefined) {
        const parsedMaxIterations = parseMaxIterationsField(
          body.value.maxIterations,
        )
        if (parsedMaxIterations.ok === false) {
          return parsedMaxIterations.response
        }
        maxIterations = parsedMaxIterations.value
      }
      const parsedSchedule = parseScheduleField(body.value.schedule)
      if (parsedSchedule.ok === false) return parsedSchedule.response
      let sessionFound: boolean
      try {
        sessionFound = await ctx.sessionExists({
          cwd,
          sessionId: sessionIdRaw.trim(),
        })
      } catch {
        return Response.json(
          { ok: false, error: 'Session validation unavailable' },
          { status: 503 },
        )
      }
      if (!sessionFound) {
        return Response.json(
          { ok: false, error: 'Session not found' },
          { status: 404 },
        )
      }

      const created = service.createScheduledForControlPlane({
        cwd,
        sessionId: sessionIdRaw.trim(),
        objective,
        acceptanceCriteria,
        ...(maxIterations !== undefined ? { maxIterations } : {}),
        schedule: parsedSchedule.value,
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

  if (actionSegment === 'events') {
    if (req.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405 })
    }
    const session = parseSessionId(url, { required: true })
    if (session.ok === false) return session.response
    const limitRaw = url.searchParams.get('limit')
    const limit = limitRaw === null ? DEFAULT_EVENT_LIMIT : Number(limitRaw)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENT_LIMIT) {
      return Response.json(
        {
          ok: false,
          error: `limit must be an integer between 1 and ${MAX_EVENT_LIMIT}`,
        },
        { status: 400 },
      )
    }
    const events = service.listScheduleEventsForControlPlane({
      cwd,
      sessionId: session.sessionId!,
      scheduleId,
      limit,
    })
    if (!events) {
      return Response.json(
        { ok: false, error: 'Schedule not found' },
        { status: 404 },
      )
    }
    return Response.json({
      scheduleId,
      events: events.map(toGoalScheduleEventSummary),
    })
  }

  if (!actionSegment && req.method === 'PATCH') {
    const body = await readJsonObject(req, MAX_DEFINITION_REQUEST_BYTES)
    if (body.ok === false) return body.response
    const sessionIdRaw = body.value.sessionId
    if (typeof sessionIdRaw !== 'string' || !isUuid(sessionIdRaw.trim())) {
      return Response.json(
        { ok: false, error: 'Valid sessionId is required' },
        { status: 400 },
      )
    }
    const expectedRevision = parseExpectedRevision(body.value.expectedRevision)
    if (expectedRevision === null) {
      return Response.json(
        { ok: false, error: 'expectedRevision must be a positive integer' },
        { status: 400 },
      )
    }

    let objective: string | undefined
    if (body.value.objective !== undefined) {
      if (
        typeof body.value.objective !== 'string' ||
        !body.value.objective.trim() ||
        body.value.objective.trim().length > MAX_GOAL_OBJECTIVE_CHARS
      ) {
        return Response.json(
          {
            ok: false,
            error: `objective must be non-empty and at most ${MAX_GOAL_OBJECTIVE_CHARS} characters`,
          },
          { status: 400 },
        )
      }
      objective = body.value.objective.trim()
    }

    let acceptanceCriteria: string[] | undefined
    if (body.value.acceptanceCriteria !== undefined) {
      const parsedCriteria = parseAcceptanceCriteriaField(
        body.value.acceptanceCriteria,
      )
      if (parsedCriteria.ok === false) return parsedCriteria.response
      acceptanceCriteria = parsedCriteria.value
    }

    let maxIterations: number | undefined
    if (body.value.maxIterations !== undefined) {
      const parsedMaxIterations = parseMaxIterationsField(
        body.value.maxIterations,
      )
      if (parsedMaxIterations.ok === false) {
        return parsedMaxIterations.response
      }
      maxIterations = parsedMaxIterations.value
    }

    let schedule: ControlPlaneGoalScheduleInput | undefined
    if (body.value.schedule !== undefined) {
      const parsedSchedule = parseScheduleField(body.value.schedule)
      if (parsedSchedule.ok === false) return parsedSchedule.response
      schedule = parsedSchedule.value
    }

    const result = service.updateScheduleForControlPlane({
      cwd,
      sessionId: sessionIdRaw.trim(),
      scheduleId,
      expectedRevision,
      ...(objective !== undefined ? { objective } : {}),
      ...(acceptanceCriteria !== undefined ? { acceptanceCriteria } : {}),
      ...(maxIterations !== undefined ? { maxIterations } : {}),
      ...(schedule !== undefined ? { schedule } : {}),
    })
    if (result.ok === false) return responseForTransitionFailure(result.reason)
    return Response.json({
      ok: true,
      schedule: toGoalScheduleSummary(result.goal),
    })
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
    const expectedRevision = parseExpectedRevision(body.value.expectedRevision)
    if (expectedRevision === null) {
      return Response.json(
        { ok: false, error: 'expectedRevision must be a positive integer' },
        { status: 400 },
      )
    }
    const action = body.value.action
    if (
      action !== 'pause' &&
      action !== 'resume' &&
      action !== 'retry' &&
      action !== 'run_now' &&
      action !== 'cancel'
    ) {
      return Response.json(
        {
          ok: false,
          error: 'action must be pause, resume, retry, run_now, or cancel',
        },
        { status: 400 },
      )
    }
    const reasonRaw = body.value.reason
    if (
      reasonRaw !== undefined &&
      (typeof reasonRaw !== 'string' ||
        reasonRaw.trim().length > MAX_ACTION_REASON_CHARS)
    ) {
      return Response.json(
        {
          ok: false,
          error: `reason must be a string of at most ${MAX_ACTION_REASON_CHARS} characters`,
        },
        { status: 400 },
      )
    }
    const reason = typeof reasonRaw === 'string' ? reasonRaw.trim() : undefined

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
