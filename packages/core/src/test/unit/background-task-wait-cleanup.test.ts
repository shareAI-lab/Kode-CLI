import { expect, test } from 'bun:test'

import {
  killBackgroundAgentTask,
  upsertBackgroundAgentTask,
  waitForBackgroundAgentTask,
  type BackgroundAgentTaskRuntime,
} from '#core/utils/backgroundTasks'

test('completed background waits remove their abort listener', async () => {
  const controller = new AbortController()
  const signal = controller.signal
  const originalAdd = signal.addEventListener.bind(signal)
  const originalRemove = signal.removeEventListener.bind(signal)
  let added = 0
  let removed = 0

  signal.addEventListener = ((...args: Parameters<typeof originalAdd>) => {
    added += 1
    return originalAdd(...args)
  }) as typeof signal.addEventListener
  signal.removeEventListener = ((
    ...args: Parameters<typeof originalRemove>
  ) => {
    removed += 1
    return originalRemove(...args)
  }) as typeof signal.removeEventListener

  const task: BackgroundAgentTaskRuntime = {
    type: 'async_agent',
    agentId: 'wait-cleanup-agent',
    description: 'wait cleanup',
    prompt: 'wait cleanup',
    status: 'running',
    cwd: process.cwd(),
    startedAt: Date.now(),
    messages: [],
    abortController: new AbortController(),
    done: Promise.resolve(),
  }
  upsertBackgroundAgentTask(task)

  try {
    await waitForBackgroundAgentTask(task.agentId, 1_000, signal)

    expect(added).toBe(1)
    expect(removed).toBe(1)
  } finally {
    // The registry is process-global across Bun test files. A resolved `done`
    // promise does not update task status by itself, so leaving this fixture
    // as `running` leaks into later task-panel and REPL layout tests.
    killBackgroundAgentTask(task.agentId)
  }
})
