import { afterEach, describe, expect, mock, test } from 'bun:test'
import React from 'react'

import { KeypressProvider } from '#ui-ink/contexts/KeypressContext'
import { createInkHarnessManager, createInkTestHarness } from './inkTestHarness'

const harnessManager = createInkHarnessManager()

async function waitForOutput(
  harness: ReturnType<typeof createInkTestHarness>,
  expected: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (harness.getOutput().includes(expected)) return
    await harness.wait(25)
  }

  throw new Error(
    `Timed out waiting for ${expected}: ${harness.getOutput().slice(-4_000)}`,
  )
}

async function waitFor(
  condition: () => boolean,
  description: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }

  throw new Error(`Timed out waiting for ${description}`)
}

afterEach(async () => {
  await harnessManager.cleanup()
  mock.restore()
})

function mockTasksDependencies(): void {
  mock.module('#core/tasks/backgroundRegistry', () => ({
    getBackgroundTaskOutputFilePath: (taskId: string) =>
      `/tmp/kode-task-${taskId}.log`,
    killBackgroundTask: () => false,
    listBackgroundTaskSnapshots: () => [
      {
        taskId: 'agent-1',
        taskType: 'local_agent',
        status: 'running',
        description: 'Test agent task',
        cwd: '/tmp/kode-tasks-test',
        outputFile: '/tmp/kode-task-agent-1.log',
        startedAt: 0,
        prompt: 'test prompt',
      },
    ],
    readBackgroundTaskOutputTailLines: () => [],
  }))
  mock.module('#core/utils/state', () => ({
    getOriginalCwd: () => '/tmp/kode-tasks-test',
  }))
  mock.module('#protocol/utils/kodeAgentSessionId', () => ({
    getKodeAgentSessionId: () => 'session-1',
  }))
  mock.module('#protocol/utils/kodeAgentSessionLog', () => ({
    getAgentLogFilePath: () => '/tmp/kode-agent-1.jsonl',
  }))
}

describe('TUI E2E regression (Ink render): TasksScreen', () => {
  test('starts one output or log editor launch and ignores completion after unmount', async () => {
    let launches = 0
    let resolveEditor:
      ((value: { ok: true; editorLabel: string }) => void) | null = null
    const finishEditor = (): void => {
      resolveEditor?.({ ok: true, editorLabel: 'test-editor' })
    }

    mockTasksDependencies()
    mock.module('#cli-utils/externalEditor', () => ({
      launchExternalEditorForFilePath: () => {
        launches += 1
        return new Promise<{ ok: true; editorLabel: string }>(resolve => {
          resolveEditor = resolve
        })
      },
    }))

    const { TasksScreen } = await import('#ui-ink/screens/overlays/TasksScreen')
    const h = createInkTestHarness(
      <KeypressProvider>
        <TasksScreen onDone={() => {}} />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await waitForOutput(h, 'Agent: agent-1 (running)')
    h.stdin.write('o')
    h.stdin.write('l')
    h.stdin.write('o')
    await waitForOutput(h, 'Opening output in external editor…')

    expect(launches).toBe(1)
    expect(h.getOutput()).toContain('Opening output in external editor…')

    h.unmount()
    finishEditor()
    await h.wait(25)
  })

  test('reports unexpected editor launcher failures and permits retry', async () => {
    let launches = 0

    mockTasksDependencies()
    mock.module('#cli-utils/externalEditor', () => ({
      launchExternalEditorForFilePath: async () => {
        launches += 1
        throw new Error('temporary editor failure')
      },
    }))

    const { TasksScreen } = await import('#ui-ink/screens/overlays/TasksScreen')
    const h = createInkTestHarness(
      <KeypressProvider>
        <TasksScreen onDone={() => {}} />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await waitForOutput(h, 'Agent: agent-1 (running)')
    h.stdin.write('o')
    await waitForOutput(
      h,
      'Unable to open the external editor. Check $EDITOR and try again.',
    )

    expect(launches).toBe(1)

    h.stdin.write('l')
    await waitFor(() => launches === 2, 'retry launcher call')
    expect(launches).toBe(2)
  })
})
