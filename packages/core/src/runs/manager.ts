import { resolve } from 'node:path'
import {
  createDurableRunId,
  listDurableRuns,
  mutateDurableRun,
  writeDurableRun,
} from './storage'
import type {
  CreateDurableRunArgs,
  DurableRun,
  DurableRunStatus,
  DurableRunTelemetry,
  ReconciledDurableRun,
} from './types'

const TERMINAL = new Set<DurableRunStatus>([
  'completed',
  'failed',
  'cancelled',
  'orphaned',
  'interrupted',
])

export function createDurableRun(args: CreateDurableRunArgs): DurableRun {
  const now = args.now ?? Date.now()
  const run: DurableRun = {
    version: 1,
    id: args.id ?? createDurableRunId(),
    kind: args.kind,
    status: 'running',
    cwd: resolve(args.cwd),
    ...(args.command ? { command: args.command } : {}),
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    ...(args.goalId ? { goalId: args.goalId } : {}),
    ...(args.worktreeId ? { worktreeId: args.worktreeId } : {}),
    ...(args.outputFile ? { outputFile: args.outputFile } : {}),
    ...(args.process ? { process: args.process } : {}),
    createdAt: now,
    updatedAt: now,
    heartbeatAt: now,
  }
  return writeDurableRun(run, args.storageRoot)
}

export function heartbeatDurableRun(args: {
  id: string
  storageRoot?: string
  now?: number
}): DurableRun | null {
  const now = args.now ?? Date.now()
  return mutateDurableRun({
    id: args.id,
    storageRoot: args.storageRoot,
    mutate: current =>
      !current || TERMINAL.has(current.status)
        ? null
        : { ...current, heartbeatAt: now, updatedAt: now },
  })
}

export function finishDurableRun(args: {
  id: string
  status: Extract<DurableRunStatus, 'completed' | 'failed' | 'cancelled'>
  error?: string
  telemetry?: DurableRunTelemetry
  storageRoot?: string
  now?: number
}): DurableRun | null {
  const now = args.now ?? Date.now()
  return mutateDurableRun({
    id: args.id,
    storageRoot: args.storageRoot,
    mutate: current =>
      !current
        ? null
        : TERMINAL.has(current.status)
          ? current
          : {
              ...current,
              status: args.status,
              ...(args.error ? { error: args.error } : {}),
              ...(args.telemetry ? { telemetry: args.telemetry } : {}),
              updatedAt: now,
              heartbeatAt: now,
              finishedAt: now,
            },
  })
}

/**
 * Reconciliation deliberately never attaches an LLM iterator. Agent/goal runs
 * become requeueable after a restart. A shell run is only marked tailable when
 * a caller supplies an exact OS process identity probe (PID alone is unsafe).
 * Legacy/unverifiable shell records are left untouched rather than incorrectly
 * orphaning a still-running task from another Kode process.
 */
export function reconcileDurableRuns(
  args: {
    storageRoot?: string
    now?: number
    probeProcess?: (identity: NonNullable<DurableRun['process']>) => {
      alive: boolean
      startToken?: string
    }
  } = {},
): ReconciledDurableRun[] {
  const now = args.now ?? Date.now()
  return listDurableRuns(args.storageRoot).map(current => {
    if (current.status !== 'running' && current.status !== 'pending') {
      return { run: current, action: 'unchanged' }
    }
    if (current.kind === 'agent' || current.kind === 'goal') {
      const run = writeDurableRun(
        {
          ...current,
          status: 'interrupted',
          error: 'Process restarted; LLM run was not reattached.',
          updatedAt: now,
          finishedAt: now,
        },
        args.storageRoot,
      )
      return { run, action: 'requeueable' }
    }
    const identity = current.process
    if (!identity || !args.probeProcess) {
      return { run: current, action: 'unchanged' }
    }
    const probe = args.probeProcess(identity)
    if (probe?.alive && probe.startToken === identity?.startToken) {
      return { run: current, action: 'tail_only' }
    }
    const run = writeDurableRun(
      {
        ...current,
        status: 'orphaned',
        error: 'Process could not be safely identified after restart.',
        updatedAt: now,
        finishedAt: now,
      },
      args.storageRoot,
    )
    return { run, action: 'orphaned' }
  })
}
