import { describe, expect, test } from 'bun:test'

import {
  __buildFlatLinesForTests,
  __filterTaskSnapshotsForTests,
  __flattenTasksTreeForTests,
  __getPreferredSelectedIndexForTests,
  __nextTaskFilterForTests,
  __resolveTasksDetailKeyActionForTests,
} from './TasksScreen'

describe('TasksScreen helpers', () => {
  test('treats detail Escape as back, not overlay close', () => {
    expect(__resolveTasksDetailKeyActionForTests({ escape: true })).toBe('back')
    expect(__resolveTasksDetailKeyActionForTests({ leftArrow: true })).toBe(
      'back',
    )
    expect(__resolveTasksDetailKeyActionForTests({ q: true })).toBe('back')
    expect(__resolveTasksDetailKeyActionForTests({ return: true })).toBe(
      'close',
    )
    expect(__resolveTasksDetailKeyActionForTests({ space: true })).toBe('close')
    expect(__resolveTasksDetailKeyActionForTests({ ctrlC: true })).toBe('close')
    expect(__resolveTasksDetailKeyActionForTests({ k: true })).toBe('kill')
  })

  test('filters local task snapshots without treating them as durable history', () => {
    const tasks = [
      { taskId: 'running', status: 'running' },
      { taskId: 'pending', status: 'pending' },
      { taskId: 'completed', status: 'completed' },
      { taskId: 'failed', status: 'failed' },
      { taskId: 'killed', status: 'killed' },
    ] as any

    expect(
      __filterTaskSnapshotsForTests(tasks, 'active').map(task => task.taskId),
    ).toEqual(['running', 'pending'])
    expect(
      __filterTaskSnapshotsForTests(tasks, 'finished').map(task => task.taskId),
    ).toEqual(['completed', 'failed', 'killed'])
    expect(__filterTaskSnapshotsForTests(tasks, 'all')).not.toBe(tasks)
    expect(__nextTaskFilterForTests('all')).toBe('active')
    expect(__nextTaskFilterForTests('active')).toBe('finished')
    expect(__nextTaskFilterForTests('finished')).toBe('all')
  })

  test('renders a nested task tree with status + error hints', () => {
    const parentTask = {
      type: 'async_agent',
      taskId: 'agent-parent',
      description: 'Research the repo',
      prompt: 'do it',
      status: 'running',
      startedAt: 1,
      messages: [] as unknown[],
    }

    const childTask = {
      type: 'async_agent',
      taskId: 'agent-child',
      parentTaskId: 'agent-parent',
      description: 'Subtask: permissions',
      prompt: 'do it',
      status: 'failed',
      startedAt: 2,
      error: 'Permission denied',
      messages: [] as unknown[],
    }

    const nodes = [
      {
        kind: 'group',
        id: 'main',
        label: 'main',
        status: 'running',
        children: [
          {
            kind: 'agent',
            task: parentTask,
            children: [{ kind: 'agent', task: childTask, children: [] }],
          },
        ],
      },
    ] as any

    const flat = __flattenTasksTreeForTests({ nodes, collapsedIds: new Set() })
    const lines = __buildFlatLinesForTests({
      items: flat as any,
      selectedIndex: -1,
      collapsedIds: new Set(),
      maxWidth: 240,
    }).map(row => row.text)

    expect(lines).toEqual([
      '▾ ● main (running)',
      '  ▾ ● Research the repo',
      '      ✗ Subtask: permissions — Permission denied',
    ])
  })

  test('collapse hides children and switches caret', () => {
    const parentTask = {
      type: 'async_agent',
      taskId: 'agent-parent',
      description: 'Parent',
      prompt: 'do it',
      status: 'running',
      startedAt: 1,
      messages: [] as unknown[],
    }

    const childTask = {
      type: 'async_agent',
      taskId: 'agent-child',
      parentTaskId: 'agent-parent',
      description: 'Child',
      prompt: 'do it',
      status: 'completed',
      startedAt: 2,
      messages: [] as unknown[],
    }

    const nodes = [
      {
        kind: 'group',
        id: 'main',
        label: 'main',
        status: 'running',
        children: [
          {
            kind: 'agent',
            task: parentTask,
            children: [{ kind: 'agent', task: childTask, children: [] }],
          },
        ],
      },
    ] as any

    const collapsed = new Set(['agent-parent'])
    const flat = __flattenTasksTreeForTests({ nodes, collapsedIds: collapsed })
    const lines = __buildFlatLinesForTests({
      items: flat as any,
      selectedIndex: -1,
      collapsedIds: collapsed,
      maxWidth: 240,
    }).map(row => row.text)

    expect(lines).toEqual(['▾ ● main (running)', '  ▸ ● Parent'])
  })

  test('collapsing a group hides all descendants', () => {
    const task = {
      type: 'async_agent',
      taskId: 'agent-1',
      description: 'Task',
      prompt: 'do it',
      status: 'running',
      startedAt: 1,
      messages: [] as unknown[],
    }

    const nodes = [
      {
        kind: 'group',
        id: 'main',
        label: 'main',
        status: 'running',
        children: [{ kind: 'agent', task, children: [] }],
      },
    ] as any

    const collapsed = new Set(['main'])
    const flat = __flattenTasksTreeForTests({ nodes, collapsedIds: collapsed })
    const lines = __buildFlatLinesForTests({
      items: flat as any,
      selectedIndex: -1,
      collapsedIds: collapsed,
      maxWidth: 240,
    }).map(row => row.text)

    expect(lines).toEqual(['▸ ● main (running)'])
  })

  test('prefers leaf details when there is only one task', () => {
    const task = {
      type: 'async_agent',
      taskId: 'agent-1',
      description: 'Only task',
      prompt: 'do it',
      status: 'running',
      startedAt: 1,
      messages: [] as unknown[],
    }

    const nodes = [
      {
        kind: 'group',
        id: 'main',
        label: 'main',
        status: 'running',
        children: [{ kind: 'agent', task, children: [] }],
      },
    ] as any

    const flat = __flattenTasksTreeForTests({ nodes, collapsedIds: new Set() })
    expect(
      __getPreferredSelectedIndexForTests({
        items: flat as any,
        currentIndex: 0,
      }),
    ).toBe(1)
  })

  test('prefers the only running task when multiple tasks exist', () => {
    const completed = {
      type: 'async_agent',
      taskId: 'agent-completed',
      description: 'Completed',
      prompt: 'do it',
      status: 'completed',
      startedAt: 1,
      messages: [] as unknown[],
    }

    const running = {
      type: 'async_agent',
      taskId: 'agent-running',
      description: 'Running',
      prompt: 'do it',
      status: 'running',
      startedAt: 2,
      messages: [] as unknown[],
    }

    const nodes = [
      {
        kind: 'group',
        id: 'main',
        label: 'main',
        status: 'running',
        children: [
          { kind: 'agent', task: completed, children: [] },
          { kind: 'agent', task: running, children: [] },
        ],
      },
    ] as any

    const flat = __flattenTasksTreeForTests({ nodes, collapsedIds: new Set() })
    expect(
      __getPreferredSelectedIndexForTests({
        items: flat as any,
        currentIndex: 0,
      }),
    ).toBe(2)
  })
})
