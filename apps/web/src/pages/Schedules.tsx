import React from 'react'
import {
  ChevronDown,
  ChevronUp,
  History,
  Pencil,
  Play,
  RefreshCw,
} from 'lucide-react'

import type {
  DaemonGoalScheduleEvent,
  DaemonGoalScheduleSummary,
  GoalScheduleControlKodeClient,
  KodeClient,
} from '@kode/client'
import type { Session } from '@kode/protocol'

import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { Label } from '../components/ui/label'
import { Separator } from '../components/ui/separator'
import { Textarea } from '../components/ui/textarea'

const MAX_CRITERIA = 32
const MAX_CRITERION_CHARS = 1_000
const MAX_OBJECTIVE_CHARS = 4_000
const MAX_ITERATIONS = 64

type GoalScheduleClient = KodeClient & GoalScheduleControlKodeClient
type ScheduleAction = 'pause' | 'resume' | 'retry' | 'run_now' | 'cancel'
type EditDraft = {
  objective: string
  criteria: string
  maxIterations: string
  every: string
  runAtLocal: string
}

function hasGoalScheduleControls(
  client: KodeClient | null,
): client is GoalScheduleClient {
  if (!client) return false
  return (
    'listGoalSchedules' in client &&
    typeof client.listGoalSchedules === 'function' &&
    'createGoalSchedule' in client &&
    typeof client.createGoalSchedule === 'function' &&
    'updateGoalSchedule' in client &&
    typeof client.updateGoalSchedule === 'function' &&
    'transitionGoalSchedule' in client &&
    typeof client.transitionGoalSchedule === 'function' &&
    'listGoalScheduleEvents' in client &&
    typeof client.listGoalScheduleEvents === 'function'
  )
}

function formatWhen(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

function padDatePart(value: number): string {
  return String(value).padStart(2, '0')
}

export function toDatetimeLocalValue(value: number): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${padDatePart(date.getMonth() + 1)}-${padDatePart(date.getDate())}T${padDatePart(date.getHours())}:${padDatePart(date.getMinutes())}`
}

export function parseDatetimeLocal(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null
  const parsed = new Date(value).getTime()
  return Number.isSafeInteger(parsed) ? parsed : null
}

export function parseEveryIntervalMs(value: string): number | null {
  const match = value.trim().match(/^(\d+)([smh])$/i)
  if (!match?.[1] || !match[2]) return null
  const count = Number.parseInt(match[1], 10)
  if (!Number.isFinite(count) || count <= 0) return null
  const unit = match[2].toLowerCase()
  const factor = unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1_000
  const ms = count * factor
  return Number.isSafeInteger(ms) ? ms : null
}

function formatEveryInterval(ms: number | undefined): string {
  if (!ms || !Number.isSafeInteger(ms)) return '30m'
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  return `${Math.max(1, Math.floor(ms / 1_000))}s`
}

function formatEveryLabel(ms: number | undefined): string {
  if (!ms) return '—'
  if (ms % 3_600_000 === 0) {
    const hours = ms / 3_600_000
    return `${hours} hour${hours === 1 ? '' : 's'}`
  }
  if (ms % 60_000 === 0) {
    const minutes = ms / 60_000
    return `${minutes} minute${minutes === 1 ? '' : 's'}`
  }
  const seconds = ms / 1_000
  return `${seconds} second${seconds === 1 ? '' : 's'}`
}

export function parseAcceptanceCriteria(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map(criterion => criterion.trim())
    .filter(Boolean)
}

function parseIterations(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_ITERATIONS
    ? parsed
    : null
}

function sessionLabel(session: Session): string {
  return (
    session.customTitle?.trim() ||
    session.slug?.trim() ||
    session.summary?.trim() ||
    session.sessionId
  )
}

function statusLabel(status: DaemonGoalScheduleSummary['status']): string {
  return status.replaceAll('_', ' ')
}

function eventLabel(type: DaemonGoalScheduleEvent['type']): string {
  return type.replaceAll('_', ' ')
}

function isEditable(schedule: DaemonGoalScheduleSummary): boolean {
  return ['scheduled', 'paused', 'failed'].includes(schedule.status)
}

function validateDefinition(args: {
  objective: string
  criteria: string
  maxIterations: string
}):
  | { ok: true; objective: string; criteria: string[]; maxIterations: number }
  | { ok: false; error: string } {
  const objective = args.objective.trim()
  if (!objective) return { ok: false, error: 'Objective is required.' }
  if (objective.length > MAX_OBJECTIVE_CHARS) {
    return {
      ok: false,
      error: `Objective cannot exceed ${MAX_OBJECTIVE_CHARS.toLocaleString()} characters.`,
    }
  }
  const criteria = parseAcceptanceCriteria(args.criteria)
  if (
    criteria.length > MAX_CRITERIA ||
    criteria.some(criterion => criterion.length > MAX_CRITERION_CHARS)
  ) {
    return {
      ok: false,
      error: `Use at most ${MAX_CRITERIA} acceptance criteria, with at most ${MAX_CRITERION_CHARS.toLocaleString()} characters per line.`,
    }
  }
  const maxIterations = parseIterations(args.maxIterations)
  if (maxIterations === null) {
    return {
      ok: false,
      error: `Max continuations must be an integer between 1 and ${MAX_ITERATIONS}.`,
    }
  }
  return { ok: true, objective, criteria, maxIterations }
}

function actionNotice(action: ScheduleAction): string {
  return action === 'pause'
    ? 'Goal paused.'
    : action === 'resume'
      ? 'Goal resumed.'
      : action === 'retry'
        ? 'Retry queued through the normal scheduler.'
        : action === 'run_now'
          ? 'Run queued through the normal scheduler.'
          : 'Goal cancelled.'
}

export function SchedulesPage(props: {
  client: KodeClient | null
  sessionId: string | null
  sessions?: Session[]
  onSelectSession?: (sessionId: string) => void
  onNewSession?: () => void
}) {
  const { client, onSelectSession, sessionId, sessions } = props
  const [schedules, setSchedules] = React.useState<DaemonGoalScheduleSummary[]>(
    [],
  )
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [objective, setObjective] = React.useState('')
  const [criteria, setCriteria] = React.useState('')
  const [every, setEvery] = React.useState('30m')
  const [maxIterations, setMaxIterations] = React.useState('8')
  const [mode, setMode] = React.useState<'interval' | 'once'>('interval')
  const [onceTiming, setOnceTiming] = React.useState<'now' | 'later'>('now')
  const [runAtLocal, setRunAtLocal] = React.useState(() =>
    toDatetimeLocalValue(Date.now() + 60 * 60_000),
  )
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [confirmCancelId, setConfirmCancelId] = React.useState<string | null>(
    null,
  )
  const [expandedId, setExpandedId] = React.useState<string | null>(null)
  const [eventsById, setEventsById] = React.useState<
    Record<string, DaemonGoalScheduleEvent[] | undefined>
  >({})
  const [eventsLoadingId, setEventsLoadingId] = React.useState<string | null>(
    null,
  )
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [editDraft, setEditDraft] = React.useState<EditDraft | null>(null)
  const refreshGeneration = React.useRef(0)
  const activeSessionRef = React.useRef(sessionId)
  const confirmCancelButtonRef = React.useRef<HTMLButtonElement | null>(null)
  activeSessionRef.current = sessionId

  const replaceSchedule = React.useCallback(
    (next: DaemonGoalScheduleSummary) => {
      setSchedules(current =>
        current
          .map(schedule => (schedule.id === next.id ? next : schedule))
          .sort((a, b) => b.updatedAt - a.updatedAt || b.revision - a.revision),
      )
    },
    [],
  )

  const refresh = React.useCallback(
    async (options: { clearError?: boolean } = {}) => {
      const generation = ++refreshGeneration.current
      if (!hasGoalScheduleControls(client)) {
        setSchedules([])
        setError('Goal schedule controls are unavailable on this client.')
        return
      }
      if (!sessionId) {
        setSchedules([])
        setError(null)
        return
      }
      setLoading(true)
      if (options.clearError !== false) setError(null)
      try {
        const next = await client.listGoalSchedules({ sessionId })
        if (generation !== refreshGeneration.current) return
        setSchedules(next)
      } catch (err) {
        if (generation !== refreshGeneration.current) return
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (generation === refreshGeneration.current) setLoading(false)
      }
    },
    [client, sessionId],
  )

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  React.useEffect(() => {
    setExpandedId(null)
    setEditingId(null)
    setEditDraft(null)
    setEventsById({})
    setEventsLoadingId(null)
    setConfirmCancelId(null)
    setBusyId(null)
    setError(null)
    setNotice(null)
  }, [sessionId])

  React.useEffect(() => {
    if (!confirmCancelId) return
    confirmCancelButtonRef.current?.focus()
  }, [confirmCancelId])

  // Prefer an explicit selection; when the page opens with sessions but no
  // active chat session, attach the most recent one so operators can act.
  React.useEffect(() => {
    if (sessionId) return
    const first = sessions?.[0]
    if (!first || !onSelectSession) return
    onSelectSession(first.sessionId)
  }, [onSelectSession, sessionId, sessions])

  const loadEvents = React.useCallback(
    async (schedule: DaemonGoalScheduleSummary, force = false) => {
      if (!hasGoalScheduleControls(client) || !sessionId) return
      if (!force && eventsById[schedule.id] !== undefined) return
      setEventsLoadingId(schedule.id)
      try {
        const events = await client.listGoalScheduleEvents(schedule.id, {
          sessionId,
          limit: 40,
        })
        if (activeSessionRef.current !== sessionId) return
        setEventsById(current => ({ ...current, [schedule.id]: events }))
      } catch (err) {
        if (activeSessionRef.current !== sessionId) return
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (activeSessionRef.current === sessionId) {
          setEventsLoadingId(current =>
            current === schedule.id ? null : current,
          )
        }
      }
    },
    [client, eventsById, sessionId],
  )

  const onCreate = async () => {
    if (!hasGoalScheduleControls(client) || !sessionId) return
    const definition = validateDefinition({
      objective,
      criteria: mode === 'once' ? criteria : '',
      maxIterations,
    })
    if (!definition.ok) {
      setError(definition.error)
      return
    }
    let schedule:
      { kind: 'once'; runAt?: number } | { kind: 'interval'; everyMs: number }
    if (mode === 'once') {
      const runAt =
        onceTiming === 'later' ? parseDatetimeLocal(runAtLocal) : null
      if (onceTiming === 'later' && (runAt === null || runAt <= Date.now())) {
        setError('Choose a future local date and time for this one-shot goal.')
        return
      }
      schedule = {
        kind: 'once',
        ...(runAt !== null ? { runAt } : {}),
      }
    } else {
      const everyMs = parseEveryIntervalMs(every)
      if (!everyMs) {
        setError('Interval must look like 30s, 5m, or 1h.')
        return
      }
      schedule = { kind: 'interval', everyMs }
    }
    setBusyId('create')
    setError(null)
    setNotice(null)
    try {
      const created = await client.createGoalSchedule({
        sessionId,
        objective: definition.objective,
        ...(definition.criteria.length > 0
          ? { acceptanceCriteria: definition.criteria }
          : {}),
        ...(mode === 'once' ? { maxIterations: definition.maxIterations } : {}),
        schedule,
      })
      if (activeSessionRef.current !== sessionId) return
      setSchedules(current => [created, ...current])
      setObjective('')
      setCriteria('')
      setNotice(
        mode === 'once' && onceTiming === 'now'
          ? 'Goal created and queued for dispatch.'
          : 'Goal schedule created.',
      )
    } catch (err) {
      if (activeSessionRef.current !== sessionId) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (activeSessionRef.current === sessionId) setBusyId(null)
    }
  }

  const onAction = async (
    schedule: DaemonGoalScheduleSummary,
    action: ScheduleAction,
  ) => {
    if (!hasGoalScheduleControls(client) || !sessionId) return
    setBusyId(`${schedule.id}:${action}`)
    setConfirmCancelId(null)
    setError(null)
    setNotice(null)
    try {
      const updated = await client.transitionGoalSchedule(schedule.id, {
        sessionId,
        expectedRevision: schedule.revision,
        action,
      })
      if (activeSessionRef.current !== sessionId) return
      replaceSchedule(updated)
      setNotice(actionNotice(action))
      if (expandedId === schedule.id) await loadEvents(updated, true)
    } catch (err) {
      if (activeSessionRef.current !== sessionId) return
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      if (/revision conflict/i.test(message)) {
        await refresh({ clearError: false })
      }
    } finally {
      if (activeSessionRef.current === sessionId) setBusyId(null)
    }
  }

  const startEdit = (schedule: DaemonGoalScheduleSummary) => {
    setEditingId(schedule.id)
    setEditDraft({
      objective: schedule.objective,
      criteria: schedule.acceptanceCriteria.join('\n'),
      maxIterations: String(schedule.maxIterations),
      every: formatEveryInterval(schedule.everyMs),
      runAtLocal: toDatetimeLocalValue(
        schedule.runAt ?? Date.now() + 60 * 60_000,
      ),
    })
    setError(null)
    setNotice(null)
  }

  const saveEdit = async (schedule: DaemonGoalScheduleSummary) => {
    if (!hasGoalScheduleControls(client) || !sessionId || !editDraft) return
    const definition = validateDefinition(editDraft)
    if (!definition.ok) {
      setError(definition.error)
      return
    }
    const nextSchedule =
      schedule.kind === 'interval'
        ? (() => {
            const everyMs = parseEveryIntervalMs(editDraft.every)
            return everyMs ? { kind: 'interval' as const, everyMs } : null
          })()
        : (() => {
            const runAt = parseDatetimeLocal(editDraft.runAtLocal)
            return runAt && runAt > Date.now()
              ? { kind: 'once' as const, runAt }
              : null
          })()
    if (!nextSchedule) {
      setError(
        schedule.kind === 'interval'
          ? 'Interval must look like 30s, 5m, or 1h.'
          : 'Choose a future local date and time.',
      )
      return
    }
    setBusyId(`${schedule.id}:edit`)
    setError(null)
    setNotice(null)
    try {
      const updated = await client.updateGoalSchedule(schedule.id, {
        sessionId,
        expectedRevision: schedule.revision,
        objective: definition.objective,
        acceptanceCriteria: definition.criteria,
        maxIterations: definition.maxIterations,
        schedule: nextSchedule,
      })
      if (activeSessionRef.current !== sessionId) return
      replaceSchedule(updated)
      setEditingId(null)
      setEditDraft(null)
      setNotice('Goal definition updated.')
      if (expandedId === schedule.id) await loadEvents(updated, true)
    } catch (err) {
      if (activeSessionRef.current !== sessionId) return
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      if (/revision conflict/i.test(message)) {
        await refresh({ clearError: false })
      }
    } finally {
      if (activeSessionRef.current === sessionId) setBusyId(null)
    }
  }

  const toggleHistory = async (schedule: DaemonGoalScheduleSummary) => {
    if (expandedId === schedule.id) {
      setExpandedId(null)
      return
    }
    setExpandedId(schedule.id)
    await loadEvents(schedule)
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col gap-4 overflow-auto p-4 md:p-8">
      <Card aria-busy={loading}>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle>Goal schedules</CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refresh()}
            disabled={loading || !props.client || !props.sessionId}
          >
            <RefreshCw aria-hidden="true" className="mr-2 h-3.5 w-3.5" />
            {loading ? 'Refreshing…' : 'Refresh'}
          </Button>
        </CardHeader>
        <CardContent className="grid gap-4">
          <p className="text-xs text-muted-foreground">
            Session-scoped durable goals. Run and retry requests still pass
            through the normal scheduler, session gate, and tool permissions.
          </p>

          <div className="grid gap-2">
            <Label htmlFor="goal-schedule-session">Session</Label>
            <div className="flex flex-wrap items-center gap-2">
              <select
                id="goal-schedule-session"
                name="goal-schedule-session"
                aria-label="Goal schedule session"
                className="h-9 min-w-[12rem] flex-1 rounded-md border border-input bg-background px-3 text-sm"
                value={props.sessionId ?? ''}
                disabled={!props.sessions?.length || Boolean(busyId)}
                onChange={event => {
                  const next = event.target.value
                  if (next) props.onSelectSession?.(next)
                }}
              >
                <option value="" disabled>
                  {props.sessions?.length
                    ? 'Select a session'
                    : 'No sessions yet'}
                </option>
                {(props.sessions ?? []).map(session => (
                  <option key={session.sessionId} value={session.sessionId}>
                    {sessionLabel(session)}
                  </option>
                ))}
              </select>
              {props.onNewSession ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => props.onNewSession?.()}
                >
                  New session
                </Button>
              ) : null}
            </div>
            {!props.sessionId ? (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
                Select an existing session or create a new one to attach goals.
              </div>
            ) : null}
          </div>

          {error ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </div>
          ) : null}
          {notice ? (
            <div
              role="status"
              aria-live="polite"
              className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-900 dark:text-emerald-100"
            >
              {notice}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2" aria-label="Goal schedule type">
            <Button
              size="sm"
              variant={mode === 'interval' ? 'default' : 'outline'}
              type="button"
              aria-pressed={mode === 'interval'}
              onClick={() => setMode('interval')}
              disabled={!props.sessionId}
            >
              Interval loop
            </Button>
            <Button
              size="sm"
              variant={mode === 'once' ? 'default' : 'outline'}
              type="button"
              aria-pressed={mode === 'once'}
              onClick={() => setMode('once')}
              disabled={!props.sessionId}
            >
              One-shot goal
            </Button>
          </div>

          <form
            onSubmit={event => {
              event.preventDefault()
              void onCreate()
            }}
            className="grid gap-3 rounded-md border border-border bg-muted/20 p-3"
          >
            <div className="grid gap-1.5">
              <Label htmlFor="goal-objective">Goal objective</Label>
              <Textarea
                id="goal-objective"
                name="goal-objective"
                autoComplete="off"
                maxLength={MAX_OBJECTIVE_CHARS}
                value={objective}
                onChange={event => setObjective(event.target.value)}
                placeholder="Describe the coding outcome, boundaries, and evidence expected…"
                disabled={!props.sessionId || busyId === 'create'}
              />
              <span className="text-xs text-muted-foreground">
                {objective.length.toLocaleString()}/
                {MAX_OBJECTIVE_CHARS.toLocaleString()}
              </span>
            </div>

            {mode === 'interval' ? (
              <div className="grid gap-1.5 sm:max-w-xs">
                <Label htmlFor="goal-interval">Run interval</Label>
                <Input
                  id="goal-interval"
                  name="goal-interval"
                  autoComplete="off"
                  spellCheck={false}
                  value={every}
                  onChange={event => setEvery(event.target.value)}
                  placeholder="30m"
                  disabled={!props.sessionId || busyId === 'create'}
                  aria-describedby="goal-interval-help"
                />
                <span
                  id="goal-interval-help"
                  className="text-xs text-muted-foreground"
                >
                  Examples: 30s, 5m, 1h. The first run starts after one
                  interval.
                </span>
              </div>
            ) : (
              <>
                <div
                  className="flex flex-wrap gap-2"
                  aria-label="First run timing"
                >
                  <Button
                    size="sm"
                    variant={onceTiming === 'now' ? 'default' : 'outline'}
                    type="button"
                    aria-pressed={onceTiming === 'now'}
                    onClick={() => setOnceTiming('now')}
                    disabled={!props.sessionId || busyId === 'create'}
                  >
                    Run when created
                  </Button>
                  <Button
                    size="sm"
                    variant={onceTiming === 'later' ? 'default' : 'outline'}
                    type="button"
                    aria-pressed={onceTiming === 'later'}
                    onClick={() => setOnceTiming('later')}
                    disabled={!props.sessionId || busyId === 'create'}
                  >
                    Schedule time
                  </Button>
                </div>
                {onceTiming === 'later' ? (
                  <div className="grid gap-1.5 sm:max-w-xs">
                    <Label htmlFor="goal-run-at">Local date and time</Label>
                    <Input
                      id="goal-run-at"
                      name="goal-run-at"
                      type="datetime-local"
                      value={runAtLocal}
                      min={toDatetimeLocalValue(Date.now())}
                      onChange={event => setRunAtLocal(event.target.value)}
                      disabled={!props.sessionId || busyId === 'create'}
                    />
                  </div>
                ) : null}
                <div className="grid gap-1.5">
                  <Label htmlFor="goal-criteria">
                    Acceptance criteria (one per line)
                  </Label>
                  <Textarea
                    id="goal-criteria"
                    name="goal-criteria"
                    autoComplete="off"
                    value={criteria}
                    onChange={event => setCriteria(event.target.value)}
                    placeholder={'Focused tests pass…\nBuild succeeds…'}
                    disabled={!props.sessionId || busyId === 'create'}
                    aria-describedby="goal-criteria-help"
                  />
                  <span
                    id="goal-criteria-help"
                    className="text-xs text-muted-foreground"
                  >
                    {parseAcceptanceCriteria(criteria).length}/{MAX_CRITERIA}{' '}
                    criteria. Mention tests, typecheck, lint, or build when that
                    evidence is required.
                  </span>
                </div>
                <div className="grid gap-1.5 sm:max-w-xs">
                  <Label htmlFor="goal-max-iterations">Max continuations</Label>
                  <Input
                    id="goal-max-iterations"
                    name="goal-max-iterations"
                    type="number"
                    min={1}
                    max={MAX_ITERATIONS}
                    inputMode="numeric"
                    value={maxIterations}
                    onChange={event => setMaxIterations(event.target.value)}
                    disabled={!props.sessionId || busyId === 'create'}
                  />
                </div>
              </>
            )}

            <div>
              <Button
                type="submit"
                disabled={!props.sessionId || busyId === 'create'}
              >
                {busyId === 'create'
                  ? 'Creating…'
                  : mode === 'interval'
                    ? 'Create loop'
                    : onceTiming === 'now'
                      ? 'Create and run'
                      : 'Schedule goal'}
              </Button>
            </div>
          </form>

          <Separator />

          {loading && schedules.length === 0 ? (
            <div role="status" className="text-sm text-muted-foreground">
              Loading goals…
            </div>
          ) : null}
          {!loading && props.sessionId && schedules.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No goals for this session yet. Create one above to start a durable
              coding workflow.
            </div>
          ) : null}

          <div className="grid gap-3">
            {schedules.map(schedule => {
              const isEditing = editingId === schedule.id && editDraft
              const isExpanded = expandedId === schedule.id
              const events = eventsById[schedule.id]
              const isBusy = busyId?.startsWith(`${schedule.id}:`) ?? false
              return (
                <article
                  key={schedule.id}
                  className="rounded-md border border-border bg-card p-3"
                  style={{
                    contentVisibility: 'auto',
                    containIntrinsicSize: 'auto 240px',
                  }}
                  aria-busy={isBusy}
                >
                  <div className="flex flex-wrap items-start gap-2">
                    <h2 className="min-w-0 flex-1 break-words text-sm font-medium leading-5">
                      {schedule.objective}
                    </h2>
                    <Badge variant="secondary">
                      {statusLabel(schedule.status)}
                    </Badge>
                    <Badge variant="outline">{schedule.kind}</Badge>
                  </div>

                  <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
                    <div>
                      <dt className="inline font-medium text-foreground">
                        Next:{' '}
                      </dt>
                      <dd className="inline">
                        {schedule.retryAt !== null
                          ? `queued ${formatWhen(schedule.retryAt)}`
                          : formatWhen(schedule.nextRunAt)}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline font-medium text-foreground">
                        Updated:{' '}
                      </dt>
                      <dd className="inline">
                        {formatWhen(schedule.updatedAt)}
                      </dd>
                    </div>
                    {schedule.kind === 'interval' ? (
                      <div>
                        <dt className="inline font-medium text-foreground">
                          Cadence:{' '}
                        </dt>
                        <dd className="inline">
                          Every {formatEveryLabel(schedule.everyMs)}
                        </dd>
                      </div>
                    ) : null}
                    <div>
                      <dt className="inline font-medium text-foreground">
                        Limit:{' '}
                      </dt>
                      <dd className="inline">
                        {schedule.maxIterations} continuations
                      </dd>
                    </div>
                    <div className="break-all sm:col-span-2">
                      <dt className="inline font-medium text-foreground">
                        ID:{' '}
                      </dt>
                      <dd className="inline font-mono" translate="no">
                        {schedule.id}
                      </dd>
                    </div>
                  </dl>

                  {schedule.status === 'running' &&
                  schedule.turnCount !== null ? (
                    <div className="mt-3 grid gap-1">
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>Continuation progress</span>
                        <span>
                          {schedule.turnCount}/{schedule.maxIterations}
                        </span>
                      </div>
                      <progress
                        className="h-2 w-full"
                        max={schedule.maxIterations}
                        value={schedule.turnCount}
                        aria-label={`Goal continuation progress: ${schedule.turnCount} of ${schedule.maxIterations}`}
                      />
                    </div>
                  ) : null}

                  {schedule.acceptanceCriteria.length > 0 ? (
                    <div className="mt-3">
                      <div className="text-xs font-medium">
                        Acceptance criteria
                      </div>
                      <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                        {schedule.acceptanceCriteria.map((criterion, index) => (
                          <li
                            key={`${schedule.id}:criterion:${index}`}
                            className="break-words"
                          >
                            {criterion}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {schedule.pausedReason || schedule.lastError ? (
                    <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100">
                      <span className="font-medium">
                        {schedule.lastError ? 'Last error: ' : 'Reason: '}
                      </span>
                      {schedule.lastError?.message ?? schedule.pausedReason}
                    </div>
                  ) : null}

                  <div className="mt-3 flex flex-wrap gap-2">
                    {schedule.status === 'scheduled' &&
                    schedule.retryAt === null ? (
                      <Button
                        size="sm"
                        disabled={Boolean(busyId) || !props.sessionId}
                        onClick={() => void onAction(schedule, 'run_now')}
                      >
                        <Play aria-hidden="true" className="mr-2 h-3.5 w-3.5" />
                        {busyId === `${schedule.id}:run_now`
                          ? 'Queuing…'
                          : 'Run now'}
                      </Button>
                    ) : null}
                    {schedule.status === 'scheduled' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={Boolean(busyId) || !props.sessionId}
                        onClick={() => void onAction(schedule, 'pause')}
                      >
                        {busyId === `${schedule.id}:pause`
                          ? 'Pausing…'
                          : 'Pause'}
                      </Button>
                    ) : null}
                    {schedule.status === 'paused' ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={Boolean(busyId) || !props.sessionId}
                        onClick={() => void onAction(schedule, 'resume')}
                      >
                        {busyId === `${schedule.id}:resume`
                          ? 'Resuming…'
                          : 'Resume'}
                      </Button>
                    ) : null}
                    {schedule.status === 'failed' ? (
                      <Button
                        size="sm"
                        disabled={Boolean(busyId) || !props.sessionId}
                        onClick={() => void onAction(schedule, 'retry')}
                      >
                        {busyId === `${schedule.id}:retry`
                          ? 'Queuing…'
                          : 'Retry'}
                      </Button>
                    ) : null}
                    {isEditable(schedule) ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={Boolean(busyId) || !props.sessionId}
                        aria-expanded={Boolean(isEditing)}
                        aria-controls={`goal-edit-${schedule.id}`}
                        onClick={() => {
                          if (isEditing) {
                            setEditingId(null)
                            setEditDraft(null)
                          } else {
                            startEdit(schedule)
                          }
                        }}
                      >
                        <Pencil
                          aria-hidden="true"
                          className="mr-2 h-3.5 w-3.5"
                        />
                        {isEditing ? 'Close edit' : 'Edit'}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={Boolean(busyId) || !props.sessionId}
                      aria-expanded={isExpanded}
                      aria-controls={`goal-history-${schedule.id}`}
                      onClick={() => void toggleHistory(schedule)}
                    >
                      <History
                        aria-hidden="true"
                        className="mr-2 h-3.5 w-3.5"
                      />
                      History
                      {isExpanded ? (
                        <ChevronUp
                          aria-hidden="true"
                          className="ml-2 h-3.5 w-3.5"
                        />
                      ) : (
                        <ChevronDown
                          aria-hidden="true"
                          className="ml-2 h-3.5 w-3.5"
                        />
                      )}
                    </Button>
                    {['scheduled', 'paused', 'failed'].includes(
                      schedule.status,
                    ) ? (
                      confirmCancelId === schedule.id ? (
                        <>
                          <Button
                            ref={confirmCancelButtonRef}
                            size="sm"
                            variant="destructive"
                            disabled={Boolean(busyId) || !props.sessionId}
                            onClick={() => void onAction(schedule, 'cancel')}
                          >
                            {busyId === `${schedule.id}:cancel`
                              ? 'Cancelling…'
                              : 'Confirm cancel'}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={Boolean(busyId)}
                            onClick={() => setConfirmCancelId(null)}
                          >
                            Keep goal
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={Boolean(busyId) || !props.sessionId}
                          onClick={() => setConfirmCancelId(schedule.id)}
                        >
                          Cancel
                        </Button>
                      )
                    ) : null}
                  </div>

                  {isEditing ? (
                    <form
                      id={`goal-edit-${schedule.id}`}
                      className="mt-3 grid gap-3 rounded-md border border-border bg-muted/30 p-3"
                      onSubmit={event => {
                        event.preventDefault()
                        void saveEdit(schedule)
                      }}
                    >
                      <div className="grid gap-1.5">
                        <Label htmlFor={`goal-edit-objective-${schedule.id}`}>
                          Objective
                        </Label>
                        <Textarea
                          id={`goal-edit-objective-${schedule.id}`}
                          value={editDraft.objective}
                          maxLength={MAX_OBJECTIVE_CHARS}
                          onChange={event =>
                            setEditDraft(current =>
                              current
                                ? { ...current, objective: event.target.value }
                                : current,
                            )
                          }
                          disabled={isBusy}
                        />
                      </div>
                      <div className="grid gap-1.5">
                        <Label htmlFor={`goal-edit-criteria-${schedule.id}`}>
                          Acceptance criteria (one per line)
                        </Label>
                        <Textarea
                          id={`goal-edit-criteria-${schedule.id}`}
                          value={editDraft.criteria}
                          onChange={event =>
                            setEditDraft(current =>
                              current
                                ? { ...current, criteria: event.target.value }
                                : current,
                            )
                          }
                          disabled={isBusy}
                        />
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        {schedule.kind === 'interval' ? (
                          <div className="grid gap-1.5">
                            <Label htmlFor={`goal-edit-every-${schedule.id}`}>
                              Run interval
                            </Label>
                            <Input
                              id={`goal-edit-every-${schedule.id}`}
                              value={editDraft.every}
                              onChange={event =>
                                setEditDraft(current =>
                                  current
                                    ? { ...current, every: event.target.value }
                                    : current,
                                )
                              }
                              disabled={isBusy}
                            />
                          </div>
                        ) : (
                          <div className="grid gap-1.5">
                            <Label htmlFor={`goal-edit-run-at-${schedule.id}`}>
                              Next local date and time
                            </Label>
                            <Input
                              id={`goal-edit-run-at-${schedule.id}`}
                              type="datetime-local"
                              min={toDatetimeLocalValue(Date.now())}
                              value={editDraft.runAtLocal}
                              onChange={event =>
                                setEditDraft(current =>
                                  current
                                    ? {
                                        ...current,
                                        runAtLocal: event.target.value,
                                      }
                                    : current,
                                )
                              }
                              disabled={isBusy}
                            />
                          </div>
                        )}
                        <div className="grid gap-1.5">
                          <Label
                            htmlFor={`goal-edit-iterations-${schedule.id}`}
                          >
                            Max continuations
                          </Label>
                          <Input
                            id={`goal-edit-iterations-${schedule.id}`}
                            type="number"
                            min={1}
                            max={MAX_ITERATIONS}
                            value={editDraft.maxIterations}
                            onChange={event =>
                              setEditDraft(current =>
                                current
                                  ? {
                                      ...current,
                                      maxIterations: event.target.value,
                                    }
                                  : current,
                              )
                            }
                            disabled={isBusy}
                          />
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button type="submit" size="sm" disabled={isBusy}>
                          {busyId === `${schedule.id}:edit`
                            ? 'Saving…'
                            : 'Save changes'}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={isBusy}
                          onClick={() => {
                            setEditingId(null)
                            setEditDraft(null)
                          }}
                        >
                          Cancel edit
                        </Button>
                      </div>
                    </form>
                  ) : null}

                  {isExpanded ? (
                    <section
                      id={`goal-history-${schedule.id}`}
                      className="mt-3 rounded-md border border-border bg-muted/20 p-3"
                      aria-label={`Execution history for ${schedule.objective}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-xs font-medium">
                          Execution history
                        </h3>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={eventsLoadingId === schedule.id}
                          onClick={() => void loadEvents(schedule, true)}
                        >
                          {eventsLoadingId === schedule.id
                            ? 'Loading…'
                            : 'Refresh history'}
                        </Button>
                      </div>
                      {eventsLoadingId === schedule.id && !events ? (
                        <div
                          role="status"
                          className="mt-2 text-xs text-muted-foreground"
                        >
                          Loading execution history…
                        </div>
                      ) : events?.length ? (
                        <ol className="mt-2 grid gap-2">
                          {events
                            .slice()
                            .reverse()
                            .map(event => (
                              <li
                                key={event.id}
                                className="border-l-2 border-border pl-3 text-xs"
                              >
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="font-medium capitalize">
                                    {eventLabel(event.type)}
                                  </span>
                                  <span className="text-muted-foreground">
                                    {formatWhen(event.at)}
                                  </span>
                                  <span className="text-muted-foreground">
                                    rev {event.revision}
                                  </span>
                                </div>
                                {event.from || event.to ? (
                                  <div className="mt-0.5 text-muted-foreground">
                                    {event.from ? statusLabel(event.from) : '—'}{' '}
                                    → {event.to ? statusLabel(event.to) : '—'}
                                  </div>
                                ) : null}
                                {event.message ? (
                                  <p className="mt-1 break-words text-muted-foreground">
                                    {event.message}
                                  </p>
                                ) : null}
                              </li>
                            ))}
                        </ol>
                      ) : (
                        <p className="mt-2 text-xs text-muted-foreground">
                          No execution events recorded.
                        </p>
                      )}
                    </section>
                  ) : null}
                </article>
              )
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
