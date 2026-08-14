import { describe, expect, test } from 'bun:test'

import type { BackgroundTaskSnapshot } from '@kode/tasks/backgroundRegistry'

import { TaskControlService } from '../taskControlService'
import { routeTask } from './task'

function createTaskService(cwd: string): TaskControlService {
  const task: BackgroundTaskSnapshot = {
    taskId: 'shell-route',
    taskType: 'local_bash',
    status: 'running',
    description: 'route task',
    command: 'echo route',
    cwd,
    sessionId: '11111111-1111-4111-8111-111111111111',
    outputFile: '/outputs/shell-route.output',
    startedAt: 1,
    exitCode: null,
    stdoutLineCount: 0,
    stderrLineCount: 0,
  }
  return new TaskControlService({
    listRuntimeTasks: () => [task],
    outputExists: () => true,
    readOutput: () => 'latest output',
  })
}

describe('routeTask', () => {
  test('serves only the selected workspace and validates output tails', async () => {
    const service = createTaskService('C:/repo')
    const ctx = {
      cwd: 'C:/repo',
      taskService: service,
      listWorkspaces: async () => ({
        currentId: 'repo',
        workspaces: [
          { id: 'repo', path: 'C:/repo' },
          { id: 'other', path: 'C:/other' },
        ],
      }),
    }

    const list = await routeTask(
      new Request('http://localhost/api/tasks?workspace=repo'),
      ctx,
    )
    expect(list?.status).toBe(200)
    await expect(list?.json()).resolves.toMatchObject({
      tasks: [expect.objectContaining({ id: 'shell-route' })],
    })

    const hidden = await routeTask(
      new Request('http://localhost/api/tasks/shell-route?workspace=other'),
      ctx,
    )
    expect(hidden?.status).toBe(404)
    await expect(hidden?.json()).resolves.toEqual({
      ok: false,
      error: 'Task not found',
    })

    const invalidTail = await routeTask(
      new Request('http://localhost/api/tasks/shell-route/output?tail=1001'),
      ctx,
    )
    expect(invalidTail?.status).toBe(400)
  })

  test('uses POST for idempotent task cancellation', async () => {
    const service = createTaskService('C:/repo')
    const ctx = { cwd: 'C:/repo', taskService: service }

    const wrongMethod = await routeTask(
      new Request('http://localhost/api/tasks/shell-route/cancel'),
      ctx,
    )
    expect(wrongMethod?.status).toBe(405)
  })
})
