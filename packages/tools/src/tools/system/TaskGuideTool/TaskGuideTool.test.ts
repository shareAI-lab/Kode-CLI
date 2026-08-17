import { afterEach, describe, expect, test } from 'bun:test'

import {
  __removeBackgroundAgentTaskForTests,
  getBackgroundAgentTaskSnapshot,
  upsertBackgroundAgentTask,
  type BackgroundAgentTaskRuntime,
} from '#core/utils/backgroundTasks'
import {
  getKodeAgentSessionId,
  setKodeAgentSessionId,
} from '#protocol/utils/kodeAgentSessionId'
import { TaskGuideTool } from './TaskGuideTool'

function installTask(
  id: string,
  status: 'running' | 'completed' = 'running',
  overrides: Partial<BackgroundAgentTaskRuntime> = {},
) {
  const task: BackgroundAgentTaskRuntime = {
    type: 'async_agent',
    agentId: id,
    parentAgentId: 'main',
    description: 'Review auth flow',
    prompt: 'Review the current auth flow.',
    status,
    cwd: process.cwd(),
    sessionId: getKodeAgentSessionId(),
    startedAt: Date.now(),
    messages: [],
    guidance: [],
    abortController: new AbortController(),
    done: Promise.resolve(),
    ...overrides,
  }
  upsertBackgroundAgentTask(task)
  return task
}

const installed: string[] = []

afterEach(() => {
  for (const id of installed.splice(0)) {
    __removeBackgroundAgentTaskForTests(id)
  }
})

describe('TaskGuide tool', () => {
  test('queues bounded guidance and reports that application is deferred', async () => {
    const id = `guide-tool-${crypto.randomUUID()}`
    installed.push(id)
    installTask(id)

    expect(
      await TaskGuideTool.validateInput(
        {
          task_id: id,
          message: 'Prioritize the cancellation race before UI polish.',
        },
        { agentId: 'main' } as never,
      ),
    ).toEqual({ result: true })

    const iterator = TaskGuideTool.call(
      {
        task_id: id,
        message: 'Prioritize the cancellation race before UI polish.',
      },
      { agentId: 'main' } as never,
    )
    const result = await iterator.next()
    if (result.done) throw new Error('Expected TaskGuide result')
    expect(result.value.data).toMatchObject({
      task_id: id,
      status: 'queued',
      pending_guidance: 1,
      delivery: 'next_model_turn_boundary',
    })
    expect(getBackgroundAgentTaskSnapshot(id)?.guidance?.[0]).toMatchObject({
      status: 'queued',
      body: 'Prioritize the cancellation race before UI polish.',
    })
  })

  test('rejects shell, terminal, and oversized targets before mutation', async () => {
    const id = `guide-tool-done-${crypto.randomUUID()}`
    installed.push(id)
    installTask(id, 'completed')
    expect(
      await TaskGuideTool.validateInput({ task_id: id, message: 'continue' }, {
        agentId: 'main',
      } as never),
    ).toMatchObject({ result: false })
    expect(
      await TaskGuideTool.validateInput(
        {
          task_id: id,
          message: '中'.repeat(6_000),
        },
        { agentId: 'main' } as never,
      ),
    ).toMatchObject({ result: false })
  })

  test('rejects guidance across session and parent-agent boundaries', async () => {
    const previousSessionId = getKodeAgentSessionId()
    const id = `guide-tool-scope-${crypto.randomUUID()}`
    installed.push(id)
    installTask(id, 'running', {
      sessionId: '11111111-1111-4111-8111-111111111111',
      parentAgentId: 'parent-agent',
    })

    try {
      setKodeAgentSessionId('22222222-2222-4222-8222-222222222222')
      await expect(
        TaskGuideTool.validateInput({ task_id: id, message: 'continue' }, {
          agentId: 'parent-agent',
        } as never),
      ).resolves.toMatchObject({
        result: false,
        message: 'Task guidance is limited to the owning session.',
      })

      setKodeAgentSessionId('11111111-1111-4111-8111-111111111111')
      await expect(
        TaskGuideTool.validateInput({ task_id: id, message: 'continue' }, {
          agentId: 'sibling-agent',
        } as never),
      ).resolves.toMatchObject({
        result: false,
        message: 'Only the agent that launched this task may guide it.',
      })
    } finally {
      setKodeAgentSessionId(previousSessionId)
    }
  })
})
