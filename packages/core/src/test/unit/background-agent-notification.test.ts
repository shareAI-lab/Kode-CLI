import { describe, expect, test } from 'bun:test'
import {
  flushBackgroundAgentNotifications,
  renderBackgroundAgentNotification,
} from '#core/tasks'
import {
  upsertBackgroundAgentTask,
  type BackgroundAgentTaskRuntime,
} from '#core/utils/backgroundTasks'

function makeAgentTask(
  overrides: Partial<BackgroundAgentTaskRuntime> = {},
): BackgroundAgentTaskRuntime {
  return {
    type: 'async_agent',
    agentId: 'notification-agent-1',
    parentAgentId: 'main',
    description: 'Review the change',
    prompt: 'Review it',
    status: 'completed',
    cwd: '/repo',
    sessionId: 'notification-session-1',
    startedAt: 100,
    completedAt: 200,
    resultText: 'done',
    messages: [],
    abortController: new AbortController(),
    done: Promise.resolve(),
    ...overrides,
  }
}

describe('background agent notifications', () => {
  test('completed task notifies once with an output-file pointer', () => {
    upsertBackgroundAgentTask(makeAgentTask())

    const [notification] = flushBackgroundAgentNotifications({
      sessionId: 'notification-session-1',
    })
    expect(notification).toMatchObject({
      taskId: 'notification-agent-1',
      taskType: 'local_agent',
      status: 'completed',
      description: 'Review the change',
    })

    const text = renderBackgroundAgentNotification(notification!)
    expect(text).toContain('<task-notification>')
    expect(text).toContain('<task-type>local_agent</task-type>')
    expect(text).toContain('<status>completed</status>')
    expect(text).toContain(
      `Read the output file to retrieve the result: ${notification!.outputFile}`,
    )

    expect(
      flushBackgroundAgentNotifications({
        sessionId: 'notification-session-1',
      }),
    ).toEqual([])
  })

  test('does not consume another session task', () => {
    upsertBackgroundAgentTask(
      makeAgentTask({
        agentId: 'notification-agent-2',
        sessionId: 'notification-session-2',
        status: 'failed',
        error: 'check failed',
      }),
    )

    expect(
      flushBackgroundAgentNotifications({
        sessionId: 'notification-session-other',
      }),
    ).toEqual([])

    const [notification] = flushBackgroundAgentNotifications({
      sessionId: 'notification-session-2',
    })
    expect(notification).toMatchObject({
      taskId: 'notification-agent-2',
      status: 'failed',
      error: 'check failed',
    })
    expect(renderBackgroundAgentNotification(notification!)).toContain(
      'Background agent "Review the change" failed',
    )
  })

  test('running task remains pending until it reaches a terminal status', () => {
    const task = makeAgentTask({
      agentId: 'notification-agent-3',
      sessionId: 'notification-session-3',
      status: 'running',
      completedAt: undefined,
    })
    upsertBackgroundAgentTask(task)

    expect(
      flushBackgroundAgentNotifications({
        sessionId: 'notification-session-3',
      }),
    ).toEqual([])

    task.status = 'killed'
    task.completedAt = 300
    upsertBackgroundAgentTask(task)

    const [notification] = flushBackgroundAgentNotifications({
      sessionId: 'notification-session-3',
    })
    expect(notification?.status).toBe('killed')
    expect(renderBackgroundAgentNotification(notification!)).toContain(
      'was killed',
    )
  })
})
