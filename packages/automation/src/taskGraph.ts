import { getTaskListId, listTasks, type Task } from '#core/tasks'

/**
 * A read-only dependency view over the durable Task store.  It deliberately
 * does not own task mutation: TaskCreate/TaskUpdate remain the single writer
 * for task records, while this module gives supervisors a stable, validated
 * graph to plan from.
 */
export const TASK_GRAPH_SCHEMA_VERSION = 1 as const

export type TaskDependencyDeclaration = 'blocks' | 'blockedBy'

export type TaskGraphEdge = {
  /** The prerequisite task. */
  from: string
  /** The task that cannot start until `from` is completed. */
  to: string
  /** Which durable task fields declared this edge. */
  declarations: TaskDependencyDeclaration[]
}

export type MissingTaskDependency = {
  /** The task record that referenced the missing task. */
  taskId: string
  dependencyId: string
  declaration: TaskDependencyDeclaration
}

export type AsymmetricTaskDependency = {
  from: string
  to: string
  declarations: TaskDependencyDeclaration[]
}

export type TaskGraphValidation = {
  valid: boolean
  /** A task ID occurring more than once cannot be scheduled safely. */
  duplicateTaskIds: string[]
  /** References to a task that is absent from the selected task list. */
  missingDependencies: MissingTaskDependency[]
  /** Each cycle repeats its first member at the end for easy rendering. */
  cycles: string[][]
  /** Non-fatal diagnostics for legacy or partially-written task records. */
  asymmetricDependencies: AsymmetricTaskDependency[]
}

export type TaskGraphSnapshot = {
  schemaVersion: typeof TASK_GRAPH_SCHEMA_VERSION
  taskListId: string
  generatedAt: number
  tasks: Task[]
  edges: TaskGraphEdge[]
  validation: TaskGraphValidation
}

export type BuildTaskGraphInput = {
  /** Defaults to the active persistent task-list ID. */
  taskListId?: string
  /** Supplying tasks makes graph inspection deterministic and side-effect free. */
  tasks?: readonly Task[]
  /** Injectable clock for deterministic consumers and tests. */
  generatedAt?: number
}

export type ReadyTaskOptions = {
  /** Pending tasks are returned by default; callers can also surface active work. */
  statuses?: readonly Task['status'][]
}

export type CriticalTaskBlocker = {
  task: Task
  /** Direct, unfinished dependents. */
  blockedTaskIds: string[]
  /** All unfinished descendants that this task gates. */
  descendantTaskIds: string[]
  /** Unfinished direct prerequisites of this task. */
  blockingTaskIds: string[]
  /** True when this blocker can be started immediately. */
  ready: boolean
  /** Number of unfinished descendants affected by this task. */
  impactCount: number
}

type GraphIndex = {
  tasks: Task[]
  tasksById: Map<string, Task>
  outgoing: Map<string, Set<string>>
  incoming: Map<string, Set<string>>
  edges: TaskGraphEdge[]
  validation: TaskGraphValidation
}

function compareStrings(left: string, right: string): number {
  return left.localeCompare(right)
}

function normalizedId(value: string): string {
  return value.trim()
}

function uniqueIds(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizedId).filter(Boolean))]
}

function cloneTask(task: Task): Task {
  return {
    ...task,
    id: normalizedId(task.id),
    blocks: uniqueIds(task.blocks),
    blockedBy: uniqueIds(task.blockedBy),
    ...(task.metadata ? { metadata: { ...task.metadata } } : {}),
  }
}

function edgeKey(from: string, to: string): string {
  return `${from}\u0000${to}`
}

function compareStringArrays(
  left: readonly string[],
  right: readonly string[],
): number {
  const max = Math.max(left.length, right.length)
  for (let index = 0; index < max; index += 1) {
    const leftValue = left[index]
    const rightValue = right[index]
    if (leftValue === undefined) return -1
    if (rightValue === undefined) return 1
    const comparison = compareStrings(leftValue, rightValue)
    if (comparison !== 0) return comparison
  }
  return 0
}

function normalizeCycle(cycle: readonly string[]): string[] {
  const members = cycle.slice(0, -1)
  if (members.length === 0) return []

  let best = [...members]
  for (let offset = 1; offset < members.length; offset += 1) {
    const candidate = [...members.slice(offset), ...members.slice(0, offset)]
    if (compareStringArrays(candidate, best) < 0) best = candidate
  }

  return [...best, best[0]!]
}

function findCycles(
  outgoing: ReadonlyMap<string, ReadonlySet<string>>,
): string[][] {
  const states = new Map<string, 'visiting' | 'visited'>()
  const stack: string[] = []
  const cycles = new Map<string, string[]>()

  const visit = (taskId: string): void => {
    states.set(taskId, 'visiting')
    stack.push(taskId)

    for (const dependentId of [...(outgoing.get(taskId) ?? [])].sort(
      compareStrings,
    )) {
      const state = states.get(dependentId)
      if (!state) {
        visit(dependentId)
        continue
      }
      if (state !== 'visiting') continue

      const cycleStart = stack.indexOf(dependentId)
      if (cycleStart < 0) continue
      const cycle = normalizeCycle([...stack.slice(cycleStart), dependentId])
      if (cycle.length > 0) cycles.set(cycle.join('\u0000'), cycle)
    }

    stack.pop()
    states.set(taskId, 'visited')
  }

  for (const taskId of [...outgoing.keys()].sort(compareStrings)) {
    if (!states.has(taskId)) visit(taskId)
  }

  return [...cycles.values()].sort(compareStringArrays)
}

function createGraphIndex(inputTasks: readonly Task[]): GraphIndex {
  const tasks = inputTasks.map(cloneTask)
  const tasksById = new Map<string, Task>()
  const duplicateTaskIds = new Set<string>()
  const outgoing = new Map<string, Set<string>>()
  const incoming = new Map<string, Set<string>>()

  for (const task of tasks) {
    if (!task.id || tasksById.has(task.id)) {
      duplicateTaskIds.add(task.id || '(empty)')
      continue
    }
    tasksById.set(task.id, task)
    outgoing.set(task.id, new Set())
    incoming.set(task.id, new Set())
  }

  const missingDependencies: MissingTaskDependency[] = []
  const edgeDeclarations = new Map<
    string,
    { from: string; to: string; declarations: Set<TaskDependencyDeclaration> }
  >()

  const registerDependency = (args: {
    from: string
    to: string
    taskId: string
    dependencyId: string
    declaration: TaskDependencyDeclaration
  }): void => {
    if (!tasksById.has(args.from) || !tasksById.has(args.to)) {
      missingDependencies.push({
        taskId: args.taskId,
        dependencyId: args.dependencyId,
        declaration: args.declaration,
      })
      return
    }

    outgoing.get(args.from)?.add(args.to)
    incoming.get(args.to)?.add(args.from)
    const key = edgeKey(args.from, args.to)
    const existing = edgeDeclarations.get(key)
    if (existing) {
      existing.declarations.add(args.declaration)
      return
    }
    edgeDeclarations.set(key, {
      from: args.from,
      to: args.to,
      declarations: new Set([args.declaration]),
    })
  }

  for (const task of tasksById.values()) {
    for (const blockedTaskId of task.blocks) {
      registerDependency({
        from: task.id,
        to: blockedTaskId,
        taskId: task.id,
        dependencyId: blockedTaskId,
        declaration: 'blocks',
      })
    }
    for (const blockingTaskId of task.blockedBy) {
      registerDependency({
        from: blockingTaskId,
        to: task.id,
        taskId: task.id,
        dependencyId: blockingTaskId,
        declaration: 'blockedBy',
      })
    }
  }

  const edges = [...edgeDeclarations.values()]
    .map(edge => ({
      from: edge.from,
      to: edge.to,
      declarations: [...edge.declarations].sort(compareStrings),
    }))
    .sort((left, right) => {
      const byFrom = compareStrings(left.from, right.from)
      return byFrom === 0 ? compareStrings(left.to, right.to) : byFrom
    })

  const asymmetricDependencies = edges
    .filter(edge => edge.declarations.length < 2)
    .map(edge => ({ ...edge }))

  const cycles = findCycles(outgoing)
  const validation: TaskGraphValidation = {
    valid:
      duplicateTaskIds.size === 0 &&
      missingDependencies.length === 0 &&
      cycles.length === 0,
    duplicateTaskIds: [...duplicateTaskIds].sort(compareStrings),
    missingDependencies: missingDependencies.sort((left, right) => {
      const byTask = compareStrings(left.taskId, right.taskId)
      if (byTask !== 0) return byTask
      const byDependency = compareStrings(left.dependencyId, right.dependencyId)
      if (byDependency !== 0) return byDependency
      return compareStrings(left.declaration, right.declaration)
    }),
    cycles,
    asymmetricDependencies,
  }

  return { tasks, tasksById, outgoing, incoming, edges, validation }
}

/**
 * Loads the current persistent Task list (unless tasks are explicitly given)
 * and validates its dependency graph without changing any task records.
 */
export function buildTaskGraph(
  input: BuildTaskGraphInput = {},
): TaskGraphSnapshot {
  const taskListId = input.taskListId ?? getTaskListId()
  const index = createGraphIndex(input.tasks ?? listTasks(taskListId))
  return {
    schemaVersion: TASK_GRAPH_SCHEMA_VERSION,
    taskListId,
    generatedAt: input.generatedAt ?? Date.now(),
    tasks: index.tasks,
    edges: index.edges,
    validation: index.validation,
  }
}

/** Validates an in-memory task list without reading or writing persistent state. */
export function validateTaskGraph(tasks: readonly Task[]): TaskGraphValidation {
  return createGraphIndex(tasks).validation
}

function cycleTaskIds(validation: TaskGraphValidation): Set<string> {
  const taskIds = new Set<string>()
  for (const cycle of validation.cycles) {
    for (const taskId of cycle.slice(0, -1)) taskIds.add(taskId)
  }
  return taskIds
}

/**
 * Returns tasks whose declared prerequisites have completed.  A missing
 * prerequisite or a cycle is deliberately treated as not-ready, even if a
 * legacy task record has otherwise inconsistent dependency fields.
 */
export function getReadyTasks(
  graph: TaskGraphSnapshot,
  options: ReadyTaskOptions = {},
): Task[] {
  const statuses = new Set<Task['status']>(options.statuses ?? ['pending'])
  const index = createGraphIndex(graph.tasks)
  const cyclicTaskIds = cycleTaskIds(index.validation)
  const missingIncomingByTask = new Set(
    index.validation.missingDependencies
      .filter(dependency => dependency.declaration === 'blockedBy')
      .map(dependency => dependency.taskId),
  )

  return index.tasks.filter(task => {
    if (!statuses.has(task.status)) return false
    if (cyclicTaskIds.has(task.id) || missingIncomingByTask.has(task.id)) {
      return false
    }
    return [...(index.incoming.get(task.id) ?? [])].every(
      dependencyId => index.tasksById.get(dependencyId)?.status === 'completed',
    )
  })
}

function getUnfinishedDescendants(args: {
  taskId: string
  index: GraphIndex
  cyclicTaskIds: ReadonlySet<string>
}): string[] {
  const visited = new Set<string>()
  const pending = [...(args.index.outgoing.get(args.taskId) ?? [])]

  while (pending.length > 0) {
    const next = pending.shift()!
    if (visited.has(next) || args.cyclicTaskIds.has(next)) continue
    visited.add(next)
    const task = args.index.tasksById.get(next)
    if (task?.status !== 'completed') {
      for (const dependentId of args.index.outgoing.get(next) ?? []) {
        pending.push(dependentId)
      }
    }
  }

  return [...visited]
    .filter(taskId => args.index.tasksById.get(taskId)?.status !== 'completed')
    .sort(compareStrings)
}

/**
 * Finds unfinished tasks that gate other unfinished work.  The result is a
 * prioritised decision aid for a supervisor; it never starts work itself.
 */
export function getCriticalTaskBlockers(
  graph: TaskGraphSnapshot,
): CriticalTaskBlocker[] {
  const index = createGraphIndex(graph.tasks)
  const cyclicTaskIds = cycleTaskIds(index.validation)
  const readyTaskIds = new Set(getReadyTasks(graph).map(task => task.id))
  const blockers: CriticalTaskBlocker[] = []

  for (const task of index.tasks) {
    if (task.status === 'completed' || cyclicTaskIds.has(task.id)) continue

    const descendantTaskIds = getUnfinishedDescendants({
      taskId: task.id,
      index,
      cyclicTaskIds,
    })
    if (descendantTaskIds.length === 0) continue

    const blockedTaskIds = [...(index.outgoing.get(task.id) ?? [])]
      .filter(taskId => index.tasksById.get(taskId)?.status !== 'completed')
      .sort(compareStrings)
    const blockingTaskIds = [...(index.incoming.get(task.id) ?? [])]
      .filter(taskId => index.tasksById.get(taskId)?.status !== 'completed')
      .sort(compareStrings)

    blockers.push({
      task,
      blockedTaskIds,
      descendantTaskIds,
      blockingTaskIds,
      ready: readyTaskIds.has(task.id),
      impactCount: descendantTaskIds.length,
    })
  }

  return blockers.sort((left, right) => {
    const byImpact = right.impactCount - left.impactCount
    if (byImpact !== 0) return byImpact
    const byReady = Number(right.ready) - Number(left.ready)
    if (byReady !== 0) return byReady
    return compareStrings(left.task.id, right.task.id)
  })
}
