import React from 'react'
import { RefreshCw } from 'lucide-react'

import type {
  DaemonGoalScheduleSummary,
  GoalScheduleControlKodeClient,
  KodeClient,
} from '@kode/client'

import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Input } from '../components/ui/input'
import { Separator } from '../components/ui/separator'
import { Badge } from '../components/ui/badge'

function hasGoalScheduleControls(
  client: KodeClient | null,
): client is KodeClient & GoalScheduleControlKodeClient {
  return (
    Boolean(client) &&
    typeof (client as GoalScheduleControlKodeClient).listGoalSchedules ===
      'function' &&
    typeof (client as GoalScheduleControlKodeClient).createGoalSchedule ===
      'function' &&
    typeof (client as GoalScheduleControlKodeClient)
      .transitionGoalSchedule === 'function'
  )
}

function formatWhen(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return new Date(value).toLocaleString()
}

export function SchedulesPage(props: {
  client: KodeClient | null
  sessionId: string | null
}) {
  const [schedules, setSchedules] = React.useState<DaemonGoalScheduleSummary[]>(
    [],
  )
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [objective, setObjective] = React.useState('')
  const [every, setEvery] = React.useState('30m')
  const [busyId, setBusyId] = React.useState<string | null>(null)

  const refresh = React.useCallback(async () => {
    if (!hasGoalScheduleControls(props.client)) {
      setSchedules([])
      setError('Goal schedule controls are unavailable on this client.')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const next = await props.client.listGoalSchedules({
        ...(props.sessionId ? { sessionId: props.sessionId } : {}),
      })
      setSchedules(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [props.client, props.sessionId])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  const parseEveryMs = (value: string): number | null => {
    const match = value.trim().match(/^(\d+)([smh])$/i)
    if (!match?.[1] || !match[2]) return null
    const count = Number.parseInt(match[1], 10)
    if (!Number.isFinite(count) || count <= 0) return null
    const unit = match[2].toLowerCase()
    const factor = unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1_000
    return count * factor
  }

  const onCreate = async () => {
    if (!hasGoalScheduleControls(props.client) || !props.sessionId) return
    const everyMs = parseEveryMs(every)
    if (!objective.trim() || !everyMs) {
      setError('Objective and interval like 30s, 5m, or 1h are required.')
      return
    }
    setBusyId('create')
    setError(null)
    try {
      await props.client.createGoalSchedule({
        sessionId: props.sessionId,
        objective: objective.trim(),
        schedule: { kind: 'interval', everyMs },
      })
      setObjective('')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  const onAction = async (
    schedule: DaemonGoalScheduleSummary,
    action: 'pause' | 'resume' | 'cancel',
  ) => {
    if (!hasGoalScheduleControls(props.client) || !props.sessionId) return
    setBusyId(`${schedule.id}:${action}`)
    setError(null)
    try {
      await props.client.transitionGoalSchedule(schedule.id, {
        sessionId: props.sessionId,
        expectedRevision: schedule.revision,
        action,
      })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-4 overflow-auto p-4 md:p-8">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle>Goal schedules</CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refresh()}
            disabled={loading || !props.client}
          >
            <RefreshCw className="mr-2 h-3.5 w-3.5" />
            Refresh
          </Button>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="text-xs text-muted-foreground">
            Session-scoped durable schedules for the attached workspace. Live
            runs cannot be cancelled here — pause/resume/cancel apply only when
            idle.
          </div>
          {!props.sessionId ? (
            <div className="text-sm text-amber-600">
              Select or start a chat session to manage schedules for it.
            </div>
          ) : null}
          {error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          <div className="grid gap-2 sm:grid-cols-[1fr_120px_auto]">
            <Input
              value={objective}
              onChange={e => setObjective(e.target.value)}
              placeholder="Objective (e.g. Check CI status)"
              disabled={!props.sessionId || busyId === 'create'}
            />
            <Input
              value={every}
              onChange={e => setEvery(e.target.value)}
              placeholder="30m"
              disabled={!props.sessionId || busyId === 'create'}
            />
            <Button
              onClick={() => void onCreate()}
              disabled={!props.sessionId || busyId === 'create'}
            >
              Create loop
            </Button>
          </div>

          <Separator />

          {loading && schedules.length === 0 ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : null}
          {!loading && schedules.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No schedules for this session yet.
            </div>
          ) : null}

          <div className="grid gap-3">
            {schedules.map(schedule => (
              <div
                key={schedule.id}
                className="rounded-md border border-border bg-card p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <div className="min-w-0 flex-1 truncate text-sm font-medium">
                    {schedule.objective}
                  </div>
                  <Badge variant="secondary">{schedule.status}</Badge>
                  <Badge variant="outline">{schedule.kind}</Badge>
                </div>
                <div className="mt-1 grid gap-1 text-xs text-muted-foreground">
                  <div>Schedule: {schedule.id}</div>
                  <div>Next run: {formatWhen(schedule.nextRunAt)}</div>
                  {schedule.kind === 'interval' ? (
                    <div>Every: {schedule.everyMs}ms</div>
                  ) : null}
                  <div>Revision: {schedule.revision}</div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {schedule.status === 'scheduled' ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={Boolean(busyId) || !props.sessionId}
                      onClick={() => void onAction(schedule, 'pause')}
                    >
                      Pause
                    </Button>
                  ) : null}
                  {schedule.status === 'paused' ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={Boolean(busyId) || !props.sessionId}
                      onClick={() => void onAction(schedule, 'resume')}
                    >
                      Resume
                    </Button>
                  ) : null}
                  {schedule.status === 'scheduled' ||
                  schedule.status === 'paused' ? (
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={Boolean(busyId) || !props.sessionId}
                      onClick={() => void onAction(schedule, 'cancel')}
                    >
                      Cancel
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
