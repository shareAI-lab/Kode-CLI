import { afterEach, describe, expect, test } from 'bun:test'

import {
  __removeBackgroundAgentTaskForTests,
  guideBackgroundAgentTask,
  upsertBackgroundAgentTask,
  type BackgroundAgentTaskRuntime,
} from '#core/utils/backgroundTasks'
import { getKodeAgentSessionId } from '#protocol/utils/kodeAgentSessionId'
import { TaskMonitorTool } from './TaskMonitorTool'

const installed: string[] = []

afterEach(() => {
  for (const id of installed.splice(0)) {
    __removeBackgroundAgentTaskForTests(id)
  }
})

describe('TaskMonitor tool', () => {
  test('shows bounded live topology and guidance state', async () => {
    const id = `monitor-tool-${crypto.randomUUID()}`
    installed.push(id)
    const now = Date.now()
    const task: BackgroundAgentTaskRuntime = {
      type: 'async_agent',
      agentId: id,
      parentAgentId: 'main',
      subagentType: 'reviewer',
      model: 'task',
      description: 'Review runtime controls',
      prompt: 'Review runtime controls.',
      status: 'running',
      cwd: process.cwd(),
      sessionId: getKodeAgentSessionId(),
      startedAt: now - 100,
      lastActivityAt: now - 10,
      turnCount: 2,
      messages: [],
      guidance: [],
      abortController: new AbortController(),
      done: Promise.resolve(),
    }
    upsertBackgroundAgentTask(task)
    guideBackgroundAgentTask({ agentId: id, body: 'Check the race.', now })

    const iterator = TaskMonitorTool.call(
      {
        action: 'get',
        task_id: id,
        include_output: false,
      },
      { agentId: 'main' } as never,
    )
    const result = await iterator.next()
    if (result.done) throw new Error('Expected TaskMonitor result')
    expect(result.value.data.tasks[0]).toMatchObject({
      task_id: id,
      parent_task_id: 'main',
      status: 'running',
      turn_count: 2,
      pending_guidance: 1,
      latest_guidance: {
        status: 'queued',
        queued_at: now,
        preview: 'Check the race.',
      },
    })
  })
})
