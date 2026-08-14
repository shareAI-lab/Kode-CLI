import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createTask,
  listTasks,
  updateTask,
  updateTaskWithDependencies,
  type Task,
} from '#core/tasks'

import {
  TaskSupervisor,
  buildTaskGraph,
  getCriticalTaskBlockers,
  getReadyTasks,
  getTaskSupervisorRunPath,
  validateTaskGraph,
} from './index'

const ENV_KEYS = [
  'HOME',
  'KODE_CONFIG_DIR',
  'CLAUDE_CONFIG_DIR',
  'KODE_TASK_LIST_ID',
] as const
const TASK_LIST_ID = 'automation-task-graph-test'

let temporaryRoot = ''
let previousEnv: Record<(typeof ENV_KEYS)[number], string | undefined>

function makeTask(args: {
  id: string
  blocks?: string[]
  blockedBy?: string[]
  status?: Task['status']
}): Task {
  return {
    id: args.id,
    subject: args.id,
    description: args.id,
    status: args.status ?? 'pending',
    blocks: args.blocks ?? [],
    blockedBy: args.blockedBy ?? [],
  }
}

function createDiamondTaskList(): {
  first: { id: string }
  second: { id: string }
  merge: { id: string }
  finish: { id: string }
} {
  const first = createTask({ subject: 'First', description: 'First' })
  const second = createTask({ subject: 'Second', description: 'Second' })
  const merge = createTask({ subject: 'Merge', description: 'Merge' })
  const finish = createTask({ subject: 'Finish', description: 'Finish' })

  expect(
    updateTaskWithDependencies({
      taskId: first.id,
      update: {},
      addBlocks: [merge.id],
    }).ok,
  ).toBe(true)
  expect(
    updateTaskWithDependencies({
      taskId: second.id,
      update: {},
      addBlocks: [merge.id],
    }).ok,
  ).toBe(true)
  expect(
    updateTaskWithDependencies({
      taskId: merge.id,
      update: {},
      addBlocks: [finish.id],
    }).ok,
  ).toBe(true)

  return { first, second, merge, finish }
}

beforeEach(() => {
  previousEnv = Object.fromEntries(
    ENV_KEYS.map(key => [key, process.env[key]]),
  ) as Record<(typeof ENV_KEYS)[number], string | undefined>
  temporaryRoot = mkdtempSync(join(tmpdir(), 'kode-task-supervisor-'))
  process.env.HOME = join(temporaryRoot, 'home')
  process.env.KODE_CONFIG_DIR = temporaryRoot
  process.env.CLAUDE_CONFIG_DIR = join(temporaryRoot, 'claude')
  process.env.KODE_TASK_LIST_ID = TASK_LIST_ID
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const previous = previousEnv[key]
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
  rmSync(temporaryRoot, { recursive: true, force: true })
})

describe('TaskGraph', () => {
  test('reports missing dependencies and deterministic cycles without mutating tasks', () => {
    const tasks = [
      makeTask({ id: 'a', blocks: ['b'] }),
      makeTask({ id: 'b', blocks: ['a', 'missing'], blockedBy: ['a'] }),
    ]

    const validation = validateTaskGraph(tasks)

    expect(validation.valid).toBe(false)
    expect(validation.missingDependencies).toEqual([
      { taskId: 'b', dependencyId: 'missing', declaration: 'blocks' },
    ])
    expect(validation.cycles).toEqual([['a', 'b', 'a']])
    expect(tasks[0]?.blocks).toEqual(['b'])
  })

  test('identifies ready work and ranks blockers by unfinished downstream impact', () => {
    const { first, second, merge, finish } = createDiamondTaskList()
    const graph = buildTaskGraph()

    expect(graph.validation.valid).toBe(true)
    expect(getReadyTasks(graph).map(task => task.id)).toEqual([
      first.id,
      second.id,
    ])
    expect(
      getCriticalTaskBlockers(graph).map(blocker => ({
        id: blocker.task.id,
        impact: blocker.impactCount,
        ready: blocker.ready,
        blocked: blocker.blockedTaskIds,
      })),
    ).toEqual([
      { id: first.id, impact: 2, ready: true, blocked: [merge.id] },
      { id: second.id, impact: 2, ready: true, blocked: [merge.id] },
      { id: merge.id, impact: 1, ready: false, blocked: [finish.id] },
    ])

    expect(
      updateTask({ taskId: first.id, update: { status: 'completed' } }).ok,
    ).toBe(true)
    expect(getReadyTasks(buildTaskGraph()).map(task => task.id)).toEqual([
      second.id,
    ])
  })
})

describe('TaskSupervisor', () => {
  test('persists serial and bounded-parallel plans under the KODE root', () => {
    const { first, second, merge, finish } = createDiamondTaskList()
    let now = 1_000
    const supervisor = new TaskSupervisor({
      rootDir: temporaryRoot,
      now: () => now,
      idFactory: () => 'generated-run',
    })

    const parallel = supervisor.plan({
      id: 'parallel-run',
      strategy: 'parallel',
      maxParallelism: 2,
    })
    expect(parallel.plan.groups.map(group => group.taskIds)).toEqual([
      [first.id, second.id],
      [merge.id],
      [finish.id],
    ])
    expect(parallel.state.status).toBe('planned')
    expect(
      existsSync(
        getTaskSupervisorRunPath({
          rootDir: temporaryRoot,
          taskListId: TASK_LIST_ID,
          id: parallel.id,
        }),
      ),
    ).toBe(true)

    now = 1_001
    const serial = supervisor.plan({ id: 'serial-run', strategy: 'serial' })
    expect(serial.plan.groups.map(group => group.taskIds)).toEqual([
      [first.id],
      [second.id],
      [merge.id],
      [finish.id],
    ])

    const restarted = new TaskSupervisor({
      rootDir: temporaryRoot,
      now: () => now,
    })
    expect(restarted.get({ id: parallel.id })?.plan.groups).toEqual(
      parallel.plan.groups,
    )
  })

  test('refreshes durable state from task storage without executing an agent', () => {
    const { first, second, merge, finish } = createDiamondTaskList()
    let now = 2_000
    const supervisor = new TaskSupervisor({
      rootDir: temporaryRoot,
      now: () => now,
    })
    const run = supervisor.plan({ id: 'state-run', strategy: 'parallel' })

    expect(
      updateTask({ taskId: first.id, update: { status: 'completed' } }).ok,
    ).toBe(true)
    expect(
      updateTask({ taskId: second.id, update: { status: 'completed' } }).ok,
    ).toBe(true)
    now += 1
    const afterPrerequisites = supervisor.refresh({ id: run.id })
    expect(afterPrerequisites.state).toMatchObject({
      status: 'planned',
      currentGroupIndex: 1,
      completedTaskIds: [first.id, second.id],
    })

    expect(
      updateTask({ taskId: merge.id, update: { status: 'in_progress' } }).ok,
    ).toBe(true)
    now += 1
    expect(supervisor.refresh({ id: run.id }).state).toMatchObject({
      status: 'running',
      currentGroupIndex: 1,
    })

    expect(
      updateTask({ taskId: merge.id, update: { status: 'completed' } }).ok,
    ).toBe(true)
    expect(
      updateTask({ taskId: finish.id, update: { status: 'completed' } }).ok,
    ).toBe(true)
    now += 1
    const completed = supervisor.refresh({ id: run.id })
    expect(completed.state).toMatchObject({
      status: 'completed',
      currentGroupIndex: null,
      completedTaskIds: [first.id, second.id, merge.id, finish.id],
    })
  })
})
