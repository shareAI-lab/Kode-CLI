import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  __removeBackgroundAgentTaskForTests,
  upsertBackgroundAgentTask,
  type BackgroundAgentTaskRuntime,
} from '#core/utils/backgroundTasks'
import { getCwd } from '#core/utils/state'
import {
  getKodeAgentSessionId,
  setKodeAgentSessionId,
} from '#protocol/utils/kodeAgentSessionId'
import { TaskGuideTool } from '#tools/tools/system/TaskGuideTool/TaskGuideTool'
import { TaskMonitorTool } from '#tools/tools/system/TaskMonitorTool/TaskMonitorTool'
import { TaskOutputTool } from '#tools/tools/system/TaskOutputTool/TaskOutputTool'
import { TaskStopTool } from '#tools/tools/system/TaskStopTool/TaskStopTool'

describe('runtime Agent control ownership isolation', () => {
  const ownedId = `owned-${crypto.randomUUID()}`
  const foreignId = `foreign-${crypto.randomUUID()}`
  const unownedId = `unowned-${crypto.randomUUID()}`
  let previousSessionId = ''

  beforeEach(() => {
    previousSessionId = getKodeAgentSessionId()
    setKodeAgentSessionId('owner-session')
    for (const [agentId, sessionId] of [
      [ownedId, 'owner-session'],
      [foreignId, 'foreign-session'],
    ] as const) {
      const task: BackgroundAgentTaskRuntime = {
        type: 'async_agent',
        agentId,
        parentAgentId: 'main',
        description: `${sessionId} task`,
        prompt: 'Wait.',
        status: 'running',
        cwd: getCwd(),
        sessionId,
        startedAt: Date.now(),
        messages: [],
        guidance: [],
        abortController: new AbortController(),
        done: Promise.resolve(),
      }
      upsertBackgroundAgentTask(task)
    }
    upsertBackgroundAgentTask({
      type: 'async_agent',
      agentId: unownedId,
      parentAgentId: 'main',
      description: 'legacy task without ownership metadata',
      prompt: 'Wait.',
      status: 'running',
      cwd: getCwd(),
      startedAt: Date.now(),
      messages: [],
      guidance: [],
      abortController: new AbortController(),
      done: Promise.resolve(),
    })
  })

  afterEach(() => {
    __removeBackgroundAgentTaskForTests(ownedId)
    __removeBackgroundAgentTaskForTests(foreignId)
    __removeBackgroundAgentTaskForTests(unownedId)
    setKodeAgentSessionId(previousSessionId)
  })

  test('monitor exposes only the current session topology', async () => {
    const iterator = TaskMonitorTool.call(
      { action: 'list', include_output: false },
      { agentId: 'main' } as never,
    )
    const result = await iterator.next()
    if (result.done) throw new Error('Expected monitor result')
    expect(result.value.data.tasks.map(task => task.task_id)).toContain(ownedId)
    expect(result.value.data.tasks.map(task => task.task_id)).not.toContain(
      foreignId,
    )
    expect(result.value.data.tasks.map(task => task.task_id)).not.toContain(
      unownedId,
    )
  })

  test('guide, output, and stop fail closed for another session task', async () => {
    const context = { agentId: 'main' } as never
    expect(
      await TaskGuideTool.validateInput(
        { task_id: foreignId, message: 'Redirect this task.' },
        context,
      ),
    ).toMatchObject({ result: false })
    expect(
      await TaskOutputTool.validateInput({
        task_id: foreignId,
        block: false,
        timeout: 0,
      }),
    ).toMatchObject({ result: false })
    expect(
      await TaskStopTool.validateInput({ task_id: foreignId }),
    ).toMatchObject({ result: false })
    expect(
      await TaskOutputTool.validateInput({
        task_id: unownedId,
        block: false,
        timeout: 0,
      }),
    ).toMatchObject({ result: false })

    expect(
      await TaskGuideTool.validateInput(
        { task_id: ownedId, message: 'Redirect this task.' },
        context,
      ),
    ).toEqual({ result: true })
  })
})
