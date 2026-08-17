import { describe, expect, test } from 'bun:test'
import { __backgroundTaskSnapshotStoreForTests } from './useBackgroundTaskSnapshots'
import type { BackgroundTaskSnapshot } from '#core/tasks/backgroundRegistry'

function task(
  status: BackgroundTaskSnapshot['status'],
): BackgroundTaskSnapshot {
  return {
    taskId: 'agent-1',
    taskType: 'local_agent',
    status,
    description: 'Run agent',
    outputFile: '/tmp/agent-1.log',
    startedAt: 1_000,
    completedAt: status === 'completed' ? 2_000 : undefined,
    prompt: 'do it',
  } as BackgroundTaskSnapshot
}

describe('background task snapshot store helpers', () => {
  test('changes signature each tick while tasks are active', () => {
    const first = __backgroundTaskSnapshotStoreForTests.buildSnapshotSignature(
      [task('running')],
      1_000,
    )
    const second = __backgroundTaskSnapshotStoreForTests.buildSnapshotSignature(
      [task('running')],
      2_000,
    )

    expect(first).not.toBe(second)
  })

  test('keeps completed task signatures stable across ticks', () => {
    const first = __backgroundTaskSnapshotStoreForTests.buildSnapshotSignature(
      [task('completed')],
      1_000,
    )
    const second = __backgroundTaskSnapshotStoreForTests.buildSnapshotSignature(
      [task('completed')],
      2_000,
    )

    expect(first).toBe(second)
  })

  test('ignores completed task output that is not rendered in the REPL panel', () => {
    const completed = task('completed') as Extract<
      BackgroundTaskSnapshot,
      { taskType: 'local_agent' }
    >
    const first = __backgroundTaskSnapshotStoreForTests.buildSnapshotSignature(
      [{ ...completed, resultText: 'first result' }],
      1_000,
    )
    const second = __backgroundTaskSnapshotStoreForTests.buildSnapshotSignature(
      [{ ...completed, resultText: 'changed but still completed' }],
      2_000,
    )

    expect(first).toBe(second)
  })

  test('ignores active shell output counts that are not rendered in the REPL panel', () => {
    const shell = {
      taskId: 'shell-1',
      taskType: 'local_bash' as const,
      status: 'running' as const,
      description: 'pnpm test',
      command: 'pnpm test',
      cwd: '/repo',
      outputFile: '/tmp/shell-1.log',
      startedAt: 1_000,
      exitCode: null,
      stdoutLineCount: 1,
      stderrLineCount: 0,
    }
    const first = __backgroundTaskSnapshotStoreForTests.buildSnapshotSignature(
      [shell],
      1_000,
    )
    const second = __backgroundTaskSnapshotStoreForTests.buildSnapshotSignature(
      [{ ...shell, stdoutLineCount: 20, stderrLineCount: 2 }],
      1_000,
    )

    expect(first).toBe(second)
  })

  test('changes when a visible task label changes', () => {
    const first = __backgroundTaskSnapshotStoreForTests.buildSnapshotSignature(
      [{ ...task('running'), description: 'First description' }],
      1_000,
    )
    const second = __backgroundTaskSnapshotStoreForTests.buildSnapshotSignature(
      [{ ...task('running'), description: 'Updated description' }],
      1_000,
    )

    expect(first).not.toBe(second)
  })
})
