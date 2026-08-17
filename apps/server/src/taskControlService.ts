import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs'
import { resolve } from 'node:path'

import { finishDurableRun, listDurableRuns, type DurableRun } from '@kode/runs'
import {
  getBackgroundTaskSnapshot,
  killBackgroundTask,
  listBackgroundTaskSnapshots,
  type BackgroundTaskSnapshot,
} from '@kode/tasks/backgroundRegistry'
import type {
  DaemonTask,
  DaemonTaskKind,
  DaemonTaskStatus,
} from '@kode/protocol'

export type TaskControlFailure =
  'not_found' | 'invalid_task_id' | 'not_attached'

export type TaskControlResult<T> =
  { ok: true; value: T } | { ok: false; reason: TaskControlFailure }

type TaskControlDependencies = {
  listRuntimeTasks: () => BackgroundTaskSnapshot[]
  getRuntimeTask: (taskId: string) => BackgroundTaskSnapshot | null
  killRuntimeTask: (taskId: string) => boolean
  listDurableTasks: () => DurableRun[]
  finishDurableTask: (args: {
    id: string
    status: 'cancelled'
  }) => DurableRun | null
  readOutput: (args: { path: string; tailLines: number | null }) => string
  outputExists: (path: string) => boolean
}

type TaskRecord = {
  task: DaemonTask
  runtime: BackgroundTaskSnapshot | null
  durable: DurableRun | null
  outputFile: string | null
}

const TERMINAL_STATUSES = new Set<DaemonTaskStatus>([
  'completed',
  'failed',
  'cancelled',
  'orphaned',
  'interrupted',
])

const MAX_OUTPUT_TAIL_BYTES = 256 * 1024

function readOutputFile(args: {
  path: string
  tailLines: number | null
}): string {
  try {
    if (!existsSync(args.path)) return ''
    if (args.tailLines === null) return readFileSync(args.path, 'utf8')

    const size = statSync(args.path).size
    if (size <= 0) return ''
    const start = Math.max(0, size - MAX_OUTPUT_TAIL_BYTES)
    const length = size - start
    const fd = openSync(args.path, 'r')
    try {
      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, start)
      let content = buffer.toString('utf8')
      if (start > 0) {
        const firstNewline = content.indexOf('\n')
        content = firstNewline >= 0 ? content.slice(firstNewline + 1) : ''
      }
      const lines = content.replace(/\r\n/g, '\n').split('\n')
      return lines.slice(-args.tailLines).join('\n')
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

function kindForRuntime(task: BackgroundTaskSnapshot): DaemonTaskKind {
  return task.taskType === 'local_bash' ? 'shell' : 'agent'
}

function statusForRuntime(task: BackgroundTaskSnapshot): DaemonTaskStatus {
  switch (task.status) {
    case 'killed':
      return 'cancelled'
    case 'pending':
    case 'running':
    case 'completed':
    case 'failed':
      return task.status
  }
}

function statusForDurable(run: DurableRun): DaemonTaskStatus {
  return run.status
}

function isInScope(args: {
  cwd: string
  sessionId?: string
  candidateCwd: string
  candidateSessionId?: string
}): boolean {
  if (!args.candidateCwd) return false
  if (resolve(args.candidateCwd) !== args.cwd) return false
  return (
    args.sessionId === undefined || args.candidateSessionId === args.sessionId
  )
}

function runtimeError(task: BackgroundTaskSnapshot | null): string | null {
  return task?.taskType === 'local_agent' ? (task.error ?? null) : null
}

function toTaskRecord(args: {
  runtime: BackgroundTaskSnapshot | null
  durable: DurableRun | null
  outputExists: (path: string) => boolean
}): TaskRecord {
  const { runtime, durable } = args
  if (!runtime && !durable) {
    throw new Error('Task record requires a runtime or durable source.')
  }

  const id = runtime?.taskId ?? durable!.id
  const outputFile = runtime?.outputFile ?? durable?.outputFile ?? null
  const startedAt = runtime?.startedAt ?? durable!.createdAt
  const completedAt = runtime?.completedAt ?? durable?.finishedAt ?? null
  const updatedAt = durable?.updatedAt ?? completedAt ?? startedAt
  const source: DaemonTask['source'] = runtime
    ? durable
      ? 'runtime_and_durable'
      : 'runtime'
    : 'durable'

  return {
    task: {
      id,
      kind: runtime ? kindForRuntime(runtime) : durable!.kind,
      status: runtime ? statusForRuntime(runtime) : statusForDurable(durable!),
      source,
      description:
        runtime?.description ??
        durable?.command ??
        durable?.goalId ??
        durable!.id,
      command:
        runtime?.taskType === 'local_bash'
          ? runtime.command
          : (durable?.command ?? null),
      sessionId: runtime?.sessionId ?? durable?.sessionId ?? null,
      startedAt,
      updatedAt,
      completedAt,
      outputAvailable: outputFile ? args.outputExists(outputFile) : false,
      error: runtimeError(runtime) ?? durable?.error ?? null,
    },
    runtime,
    durable,
    outputFile,
  }
}

function defaultDependencies(): TaskControlDependencies {
  return {
    listRuntimeTasks: listBackgroundTaskSnapshots,
    getRuntimeTask: getBackgroundTaskSnapshot,
    killRuntimeTask: killBackgroundTask,
    listDurableTasks: listDurableRuns,
    finishDurableTask: ({ id, status }) => finishDurableRun({ id, status }),
    readOutput: readOutputFile,
    outputExists: existsSync,
  }
}

/**
 * Server-owned view over runtime task handles and the durable run journal.
 * Every lookup filters by canonical workspace before it exposes task metadata,
 * output, or cancellation controls.
 */
export class TaskControlService {
  private readonly deps: TaskControlDependencies

  constructor(dependencies: Partial<TaskControlDependencies> = {}) {
    this.deps = { ...defaultDependencies(), ...dependencies }
  }

  list(args: { cwd: string; sessionId?: string }): DaemonTask[] {
    return this.listRecords(args).map(record => record.task)
  }

  get(args: {
    cwd: string
    taskId: string
    sessionId?: string
  }): TaskControlResult<DaemonTask> {
    if (!isSafeTaskId(args.taskId)) {
      return { ok: false, reason: 'invalid_task_id' }
    }
    const record = this.findRecord(args)
    return record
      ? { ok: true, value: record.task }
      : { ok: false, reason: 'not_found' }
  }

  readOutput(args: {
    cwd: string
    taskId: string
    sessionId?: string
    tailLines: number | null
  }): TaskControlResult<{ task: DaemonTask; content: string }> {
    if (!isSafeTaskId(args.taskId)) {
      return { ok: false, reason: 'invalid_task_id' }
    }
    const record = this.findRecord(args)
    if (!record) return { ok: false, reason: 'not_found' }

    return {
      ok: true,
      value: {
        task: record.task,
        content: record.outputFile
          ? this.deps.readOutput({
              path: record.outputFile,
              tailLines: args.tailLines,
            })
          : '',
      },
    }
  }

  cancel(args: {
    cwd: string
    taskId: string
    sessionId?: string
  }): TaskControlResult<{
    task: DaemonTask
    cancelled: boolean
    alreadyTerminal: boolean
  }> {
    if (!isSafeTaskId(args.taskId)) {
      return { ok: false, reason: 'invalid_task_id' }
    }
    const record = this.findRecord(args)
    if (!record) return { ok: false, reason: 'not_found' }
    if (TERMINAL_STATUSES.has(record.task.status)) {
      return {
        ok: true,
        value: { task: record.task, cancelled: false, alreadyTerminal: true },
      }
    }

    // A durable record without a current runtime handle is intentionally not
    // cancelable: after restart it may represent an external process we cannot
    // safely identify or terminate. Startup reconciliation makes that state
    // explicit as interrupted/orphaned instead of pretending cancellation won.
    if (!record.runtime || !this.deps.killRuntimeTask(args.taskId)) {
      const current = this.findRecord(args)
      if (current && TERMINAL_STATUSES.has(current.task.status)) {
        return {
          ok: true,
          value: {
            task: current.task,
            cancelled: false,
            alreadyTerminal: true,
          },
        }
      }
      return { ok: false, reason: 'not_attached' }
    }

    try {
      this.deps.finishDurableTask({ id: args.taskId, status: 'cancelled' })
    } catch {
      // Runtime cancellation has already been issued. Keep the current task
      // state visible even if a best-effort journal write is unavailable.
    }

    const updated = this.findRecord(args)
    return {
      ok: true,
      value: {
        task:
          updated?.task ??
          ({
            ...record.task,
            status: 'cancelled',
            completedAt: Date.now(),
          } as DaemonTask),
        cancelled: true,
        alreadyTerminal: false,
      },
    }
  }

  private findRecord(args: {
    cwd: string
    taskId: string
    sessionId?: string
  }): TaskRecord | null {
    return (
      this.listRecords({ cwd: args.cwd, sessionId: args.sessionId }).find(
        record => record.task.id === args.taskId,
      ) ?? null
    )
  }

  private listRecords(args: { cwd: string; sessionId?: string }): TaskRecord[] {
    const cwd = resolve(args.cwd)
    const runtimeById = new Map<string, BackgroundTaskSnapshot>()
    for (const task of this.deps.listRuntimeTasks()) {
      if (
        isInScope({
          cwd,
          sessionId: args.sessionId,
          candidateCwd: task.cwd,
          candidateSessionId: task.sessionId,
        })
      ) {
        runtimeById.set(task.taskId, task)
      }
    }

    const durableById = new Map<string, DurableRun>()
    for (const run of this.deps.listDurableTasks()) {
      if (
        isInScope({
          cwd,
          sessionId: args.sessionId,
          candidateCwd: run.cwd,
          candidateSessionId: run.sessionId,
        })
      ) {
        durableById.set(run.id, run)
      }
    }

    const ids = new Set([...runtimeById.keys(), ...durableById.keys()])
    return Array.from(ids)
      .map(id =>
        toTaskRecord({
          runtime: runtimeById.get(id) ?? null,
          durable: durableById.get(id) ?? null,
          outputExists: this.deps.outputExists,
        }),
      )
      .sort((a, b) => b.task.startedAt - a.task.startedAt)
  }
}

export function isSafeTaskId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,120}$/.test(value)
}
