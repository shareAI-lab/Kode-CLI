import { afterEach, describe, expect, test } from 'bun:test'

import {
  __removeBackgroundAgentTaskForTests,
  acknowledgeBackgroundAgentGuidance,
  BACKGROUND_AGENT_GUIDANCE_MAX_BYTES,
  BACKGROUND_AGENT_GUIDANCE_QUEUE_LIMIT,
  claimBackgroundAgentGuidance,
  formatBackgroundAgentGuidanceForContext,
  getBackgroundAgentTaskSnapshot,
  guideBackgroundAgentTask,
  releaseBackgroundAgentGuidance,
  upsertBackgroundAgentTask,
  type BackgroundAgentTaskRuntime,
} from '#core/utils/backgroundTasks'

const installed: string[] = []

function installTask(status: 'running' | 'completed' = 'running'): string {
  const agentId = `guidance-${crypto.randomUUID()}`
  const task: BackgroundAgentTaskRuntime = {
    type: 'async_agent',
    agentId,
    description: 'Guidance unit task',
    prompt: 'Wait for guidance.',
    status,
    cwd: process.cwd(),
    startedAt: Date.now(),
    messages: [],
    guidance: [],
    abortController: new AbortController(),
    done: Promise.resolve(),
  }
  upsertBackgroundAgentTask(task)
  installed.push(agentId)
  return agentId
}

afterEach(() => {
  for (const id of installed.splice(0)) {
    __removeBackgroundAgentTaskForTests(id)
  }
})

describe('background Agent runtime guidance queue', () => {
  test('claims in order, releases failures, and acknowledges accepted turns', () => {
    const agentId = installTask()
    const first = guideBackgroundAgentTask({
      agentId,
      body: 'First correction.',
      now: 10,
    })
    const second = guideBackgroundAgentTask({
      agentId,
      body: 'Second correction.',
      now: 20,
    })

    expect(
      claimBackgroundAgentGuidance({ agentId, maxItems: 1, now: 30 }),
    ).toEqual([{ ...first, status: 'claimed', claimedAt: 30 }])
    expect(
      releaseBackgroundAgentGuidance({
        agentId,
        guidanceIds: [first.guidanceId],
      }),
    ).toBe(1)
    const claimed = claimBackgroundAgentGuidance({ agentId, now: 40 })
    expect(claimed.map(item => item.guidanceId)).toEqual([
      first.guidanceId,
      second.guidanceId,
    ])
    expect(
      acknowledgeBackgroundAgentGuidance({
        agentId,
        guidanceIds: claimed.map(item => item.guidanceId),
        now: 50,
      }),
    ).toBe(2)
    expect(
      getBackgroundAgentTaskSnapshot(agentId)?.guidance?.map(
        item => item.status,
      ),
    ).toEqual(['applied', 'applied'])
  })

  test('escapes control markup and fails closed for terminal or oversized input', () => {
    const running = installTask()
    const guidance = guideBackgroundAgentTask({
      agentId: running,
      body: 'Inspect <tool> & report.',
    })
    expect(formatBackgroundAgentGuidanceForContext([guidance])).toContain(
      'Inspect &lt;tool&gt; &amp; report.',
    )

    const completed = installTask('completed')
    expect(() =>
      guideBackgroundAgentTask({ agentId: completed, body: 'continue' }),
    ).toThrow('is not running')
    expect(() =>
      guideBackgroundAgentTask({
        agentId: running,
        body: 'x'.repeat(BACKGROUND_AGENT_GUIDANCE_MAX_BYTES + 1),
      }),
    ).toThrow('exceeds')
  })

  test('bounds the pending queue without losing accepted guidance', () => {
    const agentId = installTask()
    for (
      let index = 0;
      index < BACKGROUND_AGENT_GUIDANCE_QUEUE_LIMIT;
      index += 1
    ) {
      guideBackgroundAgentTask({ agentId, body: `Guidance ${index}` })
    }
    expect(() =>
      guideBackgroundAgentTask({ agentId, body: 'One too many' }),
    ).toThrow('queue is full')
    expect(getBackgroundAgentTaskSnapshot(agentId)?.guidance).toHaveLength(
      BACKGROUND_AGENT_GUIDANCE_QUEUE_LIMIT,
    )
  })
})
