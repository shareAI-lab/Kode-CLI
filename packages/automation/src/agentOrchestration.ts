/**
 * Provider-neutral execution planning for agent work.
 *
 * This module intentionally does not import TaskTool or an LLM runtime. Core
 * owns correctness (validation, dependencies, write serialization); a CLI,
 * server, or future voice intent adapter supplies the actual launcher. That
 * avoids a core -> tools dependency cycle and never pretends a plan ran agents.
 */
export type AgentWorkMode = 'read' | 'write'

export type AgentWorkItem = {
  id: string
  agentType: string
  prompt: string
  mode: AgentWorkMode
  dependsOn?: readonly string[]
}

export type AgentExecutionGroup = {
  index: number
  /** Read-only work may run concurrently; every writer is a single-item group. */
  kind: 'parallel-read' | 'serial-write'
  tasks: AgentWorkItem[]
}

export type AgentExecutionPlan = {
  valid: boolean
  groups: AgentExecutionGroup[]
  errors: string[]
}

export type PlanAgentExecutionOptions = {
  /** Upper bound for read-only work in one group. Clamped to 1..32. */
  maxParallelism?: number
}

function normalizeParallelism(value: number | undefined): number {
  if (value === undefined) return 4
  if (!Number.isSafeInteger(value) || value < 1 || value > 32) return 0
  return value
}

function isNonEmpty(value: string): boolean {
  return value.trim().length > 0
}

/**
 * Produces a stable topological plan. To make filesystem effects predictable,
 * every write-capable task is isolated and no reads are launched alongside it.
 */
export function planAgentExecution(
  tasks: readonly AgentWorkItem[],
  options: PlanAgentExecutionOptions = {},
): AgentExecutionPlan {
  const errors: string[] = []
  const maxParallelism = normalizeParallelism(options.maxParallelism)
  if (maxParallelism === 0) {
    errors.push('maxParallelism must be an integer from 1 to 32.')
  }

  const byId = new Map<string, AgentWorkItem>()
  const order = new Map<string, number>()
  for (const [index, task] of tasks.entries()) {
    const id = task.id.trim()
    if (!id) errors.push(`Task at index ${index} has an empty id.`)
    else if (byId.has(id)) errors.push(`Task id "${id}" is duplicated.`)
    else {
      byId.set(id, {
        ...task,
        id,
        agentType: task.agentType.trim(),
        prompt: task.prompt.trim(),
      })
      order.set(id, index)
    }
    if (!isNonEmpty(task.agentType))
      errors.push(`Task ${id || index} has an empty agentType.`)
    if (!isNonEmpty(task.prompt))
      errors.push(`Task ${id || index} has an empty prompt.`)
    if (task.mode !== 'read' && task.mode !== 'write') {
      errors.push(`Task ${id || index} has an invalid mode.`)
    }
  }

  for (const task of byId.values()) {
    const dependencies = task.dependsOn ?? []
    const seen = new Set<string>()
    for (const dependency of dependencies) {
      if (!isNonEmpty(dependency)) {
        errors.push(`Task ${task.id} has an empty dependency.`)
      } else if (dependency === task.id) {
        errors.push(`Task ${task.id} cannot depend on itself.`)
      } else if (seen.has(dependency)) {
        errors.push(
          `Task ${task.id} lists dependency "${dependency}" more than once.`,
        )
      } else if (!byId.has(dependency)) {
        errors.push(`Task ${task.id} depends on missing task "${dependency}".`)
      }
      seen.add(dependency)
    }
  }
  if (errors.length > 0) return { valid: false, groups: [], errors }

  const remainingDependencies = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const task of byId.values()) {
    const dependencies = task.dependsOn ?? []
    remainingDependencies.set(task.id, dependencies.length)
    for (const dependency of dependencies) {
      const list = dependents.get(dependency) ?? []
      list.push(task.id)
      dependents.set(dependency, list)
    }
  }

  const compare = (left: string, right: string) =>
    (order.get(left) ?? Number.MAX_SAFE_INTEGER) -
    (order.get(right) ?? Number.MAX_SAFE_INTEGER)
  const readReady = [...byId.values()]
    .filter(task => remainingDependencies.get(task.id) === 0)
    .filter(task => task.mode === 'read')
    .map(task => task.id)
    .sort(compare)
  const writeReady = [...byId.values()]
    .filter(task => remainingDependencies.get(task.id) === 0)
    .filter(task => task.mode === 'write')
    .map(task => task.id)
    .sort(compare)
  const enqueueReady = (id: string) => {
    const queue = byId.get(id)!.mode === 'read' ? readReady : writeReady
    queue.push(id)
    // Only newly-released work is sorted. A broad dependency-free workload
    // therefore stays O(n), rather than repeatedly sorting every ready task.
    queue.sort(compare)
  }
  const groups: AgentExecutionGroup[] = []
  let completed = 0
  while (readReady.length > 0 || writeReady.length > 0) {
    const groupTaskIds =
      readReady.length > 0
        ? readReady.splice(0, maxParallelism)
        : [writeReady.shift()!]
    const groupTasks = groupTaskIds.map(id => byId.get(id)!)
    groups.push({
      index: groups.length,
      kind: groupTasks[0]!.mode === 'read' ? 'parallel-read' : 'serial-write',
      tasks: groupTasks,
    })
    for (const task of groupTasks) {
      completed += 1
      for (const dependent of dependents.get(task.id) ?? []) {
        const next = (remainingDependencies.get(dependent) ?? 1) - 1
        remainingDependencies.set(dependent, next)
        if (next === 0) enqueueReady(dependent)
      }
    }
  }

  if (completed !== tasks.length) {
    return {
      valid: false,
      groups: [],
      errors: ['Agent work dependencies contain a cycle.'],
    }
  }
  return { valid: true, groups, errors: [] }
}

export type AgentExecutionOutcome<T> =
  | { id: string; status: 'completed'; value: T }
  | { id: string; status: 'failed'; error: unknown }
  | { id: string; status: 'blocked'; reason: string }

export type ExecuteAgentPlanOptions<T> = {
  launch(task: AgentWorkItem): Promise<T>
  signal?: AbortSignal
}

export type AgentExecutionEvent<T> =
  | { type: 'group_started'; group: AgentExecutionGroup }
  | {
      type: 'task_finished'
      group: AgentExecutionGroup
      outcome: AgentExecutionOutcome<T>
    }
  | { type: 'group_finished'; group: AgentExecutionGroup }

/**
 * Executes an already-valid plan through an injected launcher, exposing stable
 * group/task lifecycle events for hosts that need responsive progress UI. A
 * failed task blocks only its downstream dependents; independent planned work
 * continues.
 */
export async function* executeAgentPlanEvents<T>(
  plan: AgentExecutionPlan,
  options: ExecuteAgentPlanOptions<T>,
): AsyncGenerator<AgentExecutionEvent<T>> {
  if (!plan.valid)
    throw new Error(
      `Cannot execute an invalid agent plan: ${plan.errors.join(' ')}`,
    )
  const failedOrBlocked = new Set<string>()
  for (const group of plan.groups) {
    yield { type: 'group_started', group }
    if (options.signal?.aborted) {
      for (const task of group.tasks) {
        yield {
          type: 'task_finished',
          group,
          outcome: {
            id: task.id,
            status: 'blocked',
            reason: 'Execution was cancelled.',
          },
        }
      }
      yield { type: 'group_finished', group }
      continue
    }
    const run = async (
      task: AgentWorkItem,
    ): Promise<AgentExecutionOutcome<T>> => {
      const blockedDependency = (task.dependsOn ?? []).find(id =>
        failedOrBlocked.has(id),
      )
      if (blockedDependency) {
        failedOrBlocked.add(task.id)
        return {
          id: task.id,
          status: 'blocked',
          reason: `Dependency ${blockedDependency} did not complete successfully.`,
        }
      }
      try {
        return {
          id: task.id,
          status: 'completed',
          value: await options.launch(task),
        }
      } catch (error) {
        failedOrBlocked.add(task.id)
        return { id: task.id, status: 'failed', error }
      }
    }
    if (group.kind === 'parallel-read') {
      const pending = new Map(
        group.tasks.map((task, index) => [
          index,
          run(task).then(outcome => ({ index, outcome })),
        ]),
      )
      while (pending.size > 0) {
        const finished = await Promise.race(pending.values())
        pending.delete(finished.index)
        yield { type: 'task_finished', group, outcome: finished.outcome }
      }
    } else {
      yield {
        type: 'task_finished',
        group,
        outcome: await run(group.tasks[0]!),
      }
    }
    yield { type: 'group_finished', group }
  }
}

/** Collect the event stream for hosts that only need terminal task outcomes. */
export async function executeAgentPlan<T>(
  plan: AgentExecutionPlan,
  options: ExecuteAgentPlanOptions<T>,
): Promise<AgentExecutionOutcome<T>[]> {
  const outcomes: AgentExecutionOutcome<T>[] = []
  for await (const event of executeAgentPlanEvents(plan, options)) {
    if (event.type === 'task_finished') outcomes.push(event.outcome)
  }
  return outcomes
}
