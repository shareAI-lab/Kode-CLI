import type { Command } from '../types'
import {
  listDurableRuns,
  reconcileDurableRuns,
  type DurableRun,
  type DurableRunStatus,
} from '#core/runs'

type RunFilter = 'all' | 'active' | 'finished' | 'failed'

const STATUS_USAGE = 'Usage: /runs status [all|active|finished|failed]'

function isRunFilter(value: string): value is RunFilter {
  return ['all', 'active', 'finished', 'failed'].includes(value)
}

function matchesFilter(run: DurableRun, filter: RunFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'active') {
    return run.status === 'pending' || run.status === 'running'
  }
  if (filter === 'failed') {
    return (
      run.status === 'failed' ||
      run.status === 'orphaned' ||
      run.status === 'interrupted'
    )
  }
  return !['pending', 'running'].includes(run.status)
}

function formatUpdatedAt(updatedAt: number): string {
  const date = new Date(updatedAt)
  return Number.isNaN(date.getTime()) ? 'unknown time' : date.toISOString()
}

function isRetryableFailure(run: DurableRun): boolean {
  return run.telemetry?.failure?.retryable === true
}

export function __formatDurableRunForTests(run: DurableRun): string {
  const retry = isRetryableFailure(run) ? ' · retry available' : ''
  const action = run.telemetry?.failure?.recommendedAction
  const guidance = action ? `next: ${action}` : ''
  return [
    `${run.id} · ${run.kind} · ${run.status}${retry}`,
    `updated ${formatUpdatedAt(run.updatedAt)} · cwd ${run.cwd}`,
    guidance || null,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n')
}

export function __formatDurableRunListForTests(args: {
  runs: readonly DurableRun[]
  filter: RunFilter
}): string {
  const visible = args.runs
    .filter(run => matchesFilter(run, args.filter))
    .slice()
    .sort((left, right) => right.updatedAt - left.updatedAt)

  if (visible.length === 0) {
    return `No local durable runs found for filter: ${args.filter}.`
  }

  return [
    `Local durable-run records (${args.filter}). These statuses do not prove remote task completion.`,
    ...visible.map(__formatDurableRunForTests),
  ].join('\n\n')
}

function parseStatusFilter(args: string): RunFilter | null {
  const value = args.trim().toLowerCase()
  if (!value) return 'all'
  return isRunFilter(value) ? value : null
}

function formatReconcileAction(args: {
  id: string
  action: 'tail_only' | 'requeueable' | 'orphaned' | 'unchanged'
  status: DurableRunStatus
}): string {
  const note =
    args.action === 'requeueable'
      ? 'not resumed automatically; start a new run after reviewing context'
      : args.action === 'tail_only'
        ? 'safe process identity confirmed; output may be tailed only'
        : args.action === 'orphaned'
          ? 'process identity could not be verified'
          : 'no local state change'
  return `${args.id} · ${args.status} · ${note}`
}

const runs = {
  type: 'local',
  name: 'runs',
  description: 'Inspect locally persisted durable-run records',
  argumentHint: 'status [all|active|finished|failed] | reconcile',
  isEnabled: true,
  isHidden: true,
  disableNonInteractive: true,
  async call(args) {
    const [verb, ...rest] = args.trim().split(/\s+/)
    if (verb === 'status') {
      const filter = parseStatusFilter(rest.join(' '))
      if (!filter) return STATUS_USAGE
      return __formatDurableRunListForTests({
        runs: listDurableRuns(),
        filter,
      })
    }
    if (verb === 'reconcile') {
      const items = reconcileDurableRuns()
      if (items.length === 0) return 'No local durable runs found to reconcile.'
      return [
        'Reconciled local durable-run records. No remote task was restarted.',
        ...items.map(item =>
          formatReconcileAction({
            id: item.run.id,
            action: item.action,
            status: item.run.status,
          }),
        ),
      ].join('\n')
    }
    return `${STATUS_USAGE}\nUsage: /runs reconcile`
  },
  userFacingName() {
    return 'runs'
  },
} satisfies Command

export default runs
