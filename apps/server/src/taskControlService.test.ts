import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import type { DurableRun } from '@kode/runs'
import type { BackgroundTaskSnapshot } from '@kode/tasks/backgroundRegistry'

import { TaskControlService } from './taskControlService'

function makeShellTask(args: {
  id: string
  cwd: string
  sessionId?: string
  status?: 'running' | 'completed' | 'failed' | 'killed'
}): BackgroundTaskSnapshot {
  return {
    taskId: args.id,
    taskType: 'local_bash',
    status: args.status ?? 'running',
    description: 'run checks',
    command: 'bun test',
    cwd: args.cwd,
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    outputFile: `/outputs/${args.id}.output`,
    startedAt: 10,
    ...(args.status && args.status !== 'running' ? { completedAt: 20 } : {}),
    exitCode: args.status === 'completed' ? 0 : null,
    stdoutLineCount: 0,
    stderrLineCount: 0,
  }
}

function makeDurableRun(args: {
  id: string
  cwd: string
  kind?: DurableRun['kind']
  sessionId?: string
  status?: DurableRun['status']
  outputFile?: string
}): DurableRun {
  return {
    version: 1,
    id: args.id,
    kind: args.kind ?? 'agent',
    status: args.status ?? 'running',
    cwd: args.cwd,
    command: 'durable task',
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    ...(args.outputFile ? { outputFile: args.outputFile } : {}),
    createdAt: 10,
    updatedAt: 11,
    heartbeatAt: 11,
  }
}

describe('TaskControlService', () => {
  test('never exposes task metadata or output across workspaces', () => {
    const workspaceA = join(process.cwd(), 'task-control-workspace-a')
    const workspaceB = join(process.cwd(), 'task-control-workspace-b')
    let outputReads = 0
    const service = new TaskControlService({
      listRuntimeTasks: () => [
        makeShellTask({ id: 'shell-a', cwd: workspaceA }),
      ],
      listDurableTasks: () => [],
      readOutput: () => {
        outputReads += 1
        return 'private output'
      },
      outputExists: () => true,
    })

    expect(service.list({ cwd: workspaceB })).toEqual([])
    expect(service.get({ cwd: workspaceB, taskId: 'shell-a' })).toEqual({
      ok: false,
      reason: 'not_found',
    })
    expect(
      service.readOutput({
        cwd: workspaceB,
        taskId: 'shell-a',
        tailLines: 50,
      }),
    ).toEqual({ ok: false, reason: 'not_found' })
    expect(outputReads).toBe(0)
  })

  test('uses durable metadata and recorded output after the runtime has restarted', () => {
    const workspace = join(process.cwd(), 'task-control-restarted')
    const outputFile = '/outputs/agent-restarted.output'
    const service = new TaskControlService({
      listRuntimeTasks: () => [],
      listDurableTasks: () => [
        makeDurableRun({
          id: 'agent-restarted',
          cwd: workspace,
          kind: 'agent',
          sessionId: 'session-a',
          status: 'interrupted',
          outputFile,
        }),
      ],
      outputExists: path => path === outputFile,
      readOutput: ({ path, tailLines }) => {
        expect(path).toBe(outputFile)
        expect(tailLines).toBe(2)
        return 'last durable output'
      },
    })

    expect(service.list({ cwd: workspace })).toMatchObject([
      {
        id: 'agent-restarted',
        source: 'durable',
        status: 'interrupted',
        sessionId: 'session-a',
        outputAvailable: true,
      },
    ])
    expect(
      service.readOutput({
        cwd: workspace,
        taskId: 'agent-restarted',
        tailLines: 2,
      }),
    ).toEqual({
      ok: true,
      value: {
        task: expect.objectContaining({ id: 'agent-restarted' }),
        content: 'last durable output',
      },
    })
  })

  test('cancels an attached task once and preserves the terminal journal state', () => {
    const workspace = join(process.cwd(), 'task-control-cancel')
    let runtime = [makeShellTask({ id: 'shell-cancel', cwd: workspace })]
    let durable = [
      makeDurableRun({
        id: 'shell-cancel',
        cwd: workspace,
        kind: 'shell',
        status: 'running',
      }),
    ]
    let kills = 0
    const service = new TaskControlService({
      listRuntimeTasks: () => runtime,
      listDurableTasks: () => durable,
      killRuntimeTask: taskId => {
        if (taskId !== 'shell-cancel') return false
        kills += 1
        runtime = [
          makeShellTask({
            id: taskId,
            cwd: workspace,
            status: 'killed',
          }),
        ]
        return true
      },
      finishDurableTask: ({ id }) => {
        const current = durable.find(run => run.id === id) ?? null
        if (!current) return null
        const next: DurableRun = {
          ...current,
          status: 'cancelled',
          updatedAt: 20,
          heartbeatAt: 20,
          finishedAt: 20,
        }
        durable = [next]
        return next
      },
      outputExists: () => false,
    })

    expect(service.cancel({ cwd: workspace, taskId: 'shell-cancel' })).toEqual({
      ok: true,
      value: {
        task: expect.objectContaining({
          id: 'shell-cancel',
          status: 'cancelled',
        }),
        cancelled: true,
        alreadyTerminal: false,
      },
    })
    expect(service.cancel({ cwd: workspace, taskId: 'shell-cancel' })).toEqual({
      ok: true,
      value: {
        task: expect.objectContaining({ status: 'cancelled' }),
        cancelled: false,
        alreadyTerminal: true,
      },
    })
    expect(kills).toBe(1)
    expect(durable[0]?.status).toBe('cancelled')
  })
})
