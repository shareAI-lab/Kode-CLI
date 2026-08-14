import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'

import { getKodeRoot } from '#config/dataRoots'
import { getTaskListId, sanitizeTaskListId } from '#core/tasks'

import {
  TASK_GRAPH_SCHEMA_VERSION,
  buildTaskGraph,
  type TaskGraphSnapshot,
  type TaskGraphValidation,
} from './taskGraph'

/**
 * The supervisor persists plans and observed task state, but intentionally
 * does not invoke an LLM or claim a background worker.  Runtimes can adopt a
 * run safely by reading its plan and then deciding how to execute each group.
 */
export const TASK_SUPERVISOR_SCHEMA_VERSION = 1 as const

export type SupervisorRunStrategy = 'serial' | 'parallel'

export type SupervisorRunStatus =
  'planned' | 'running' | 'blocked' | 'completed' | 'cancelled'

export type SupervisorRunGroup = {
  index: number
  kind: SupervisorRunStrategy
  taskIds: string[]
}

export type SupervisorRunPlan = {
  graphSchemaVersion: typeof TASK_GRAPH_SCHEMA_VERSION
  strategy: SupervisorRunStrategy
  maxParallelism: number
  taskIds: string[]
  groups: SupervisorRunGroup[]
  validation: TaskGraphValidation
}

export type SupervisorRunState = {
  status: SupervisorRunStatus
  /** Null only when there is no remaining runnable group. */
  currentGroupIndex: number | null
  completedTaskIds: string[]
  /** Invalid/missing graph members that require user intervention. */
  blockedTaskIds: string[]
  validation: TaskGraphValidation
  lastObservedAt: number
  reason?: string
}

export type SupervisorRun = {
  schemaVersion: typeof TASK_SUPERVISOR_SCHEMA_VERSION
  id: string
  taskListId: string
  createdAt: number
  updatedAt: number
  plan: SupervisorRunPlan
  state: SupervisorRunState
}

export type TaskSupervisorOptions = {
  /**
   * Root for supervisor record files; task records continue to use the
   * existing Task storage root and task-list selection.
   */
  rootDir?: string
  now?: () => number
  idFactory?: () => string
}

export type PlanSupervisorRunInput = {
  id?: string
  taskListId?: string
  strategy?: SupervisorRunStrategy
  /** Bounds the size of a parallel group. Ignored for serial plans. */
  maxParallelism?: number
}

export type SupervisorRunLookup = {
  id: string
  taskListId?: string
}

export type ListSupervisorRunsInput = {
  taskListId?: string
  rootDir?: string
}

export type CancelSupervisorRunInput = SupervisorRunLookup & {
  reason?: string
}

const SUPERVISOR_DIRNAME = 'automation'
const RUNS_DIRNAME = 'task-supervisors'
const RUN_STATUSES = new Set<SupervisorRunStatus>([
  'planned',
  'running',
  'blocked',
  'completed',
  'cancelled',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Temporary-file cleanup must not hide the original persistence failure.
  }
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.tmp.${process.pid}.${randomUUID()}`
  const content = JSON.stringify(value, null, 2)
  writeFileSync(temporaryPath, content, { encoding: 'utf8', mode: 0o600 })
  try {
    renameSync(temporaryPath, path)
  } catch (error) {
    // Windows may reject a replace-rename while a scanner has the old file
    // open.  The fallback keeps the state durable and removes the temp file.
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    const canFallback = [
      'EPERM',
      'EACCES',
      'EEXIST',
      'ENOTEMPTY',
      'EBUSY',
    ].includes(String(code ?? ''))
    if (!canFallback) {
      safeUnlink(temporaryPath)
      throw error
    }
    try {
      writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 })
    } finally {
      safeUnlink(temporaryPath)
    }
  }
}

function safeRunId(value: string): string {
  const id = value.trim()
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(id)) {
    throw new Error(
      'Supervisor run id must contain only letters, numbers, underscores, or hyphens.',
    )
  }
  return id
}

function taskListStorageKey(taskListId: string): string {
  const key = sanitizeTaskListId(taskListId.trim())
  if (!key) throw new Error('Task list id cannot be empty.')
  return key
}

/** The root contains only automation-owned data under the current KODE root. */
export function getTaskSupervisorStorageRoot(rootDir?: string): string {
  return resolve(rootDir ?? getKodeRoot(), SUPERVISOR_DIRNAME, RUNS_DIRNAME)
}

export function getTaskSupervisorRunPath(args: {
  id: string
  taskListId: string
  rootDir?: string
}): string {
  return join(
    getTaskSupervisorStorageRoot(args.rootDir),
    taskListStorageKey(args.taskListId),
    `${safeRunId(args.id)}.json`,
  )
}

function isValidation(value: unknown): value is TaskGraphValidation {
  return (
    isRecord(value) &&
    typeof value.valid === 'boolean' &&
    Array.isArray(value.duplicateTaskIds) &&
    Array.isArray(value.missingDependencies) &&
    Array.isArray(value.cycles) &&
    Array.isArray(value.asymmetricDependencies)
  )
}

function parseRun(value: unknown): SupervisorRun | null {
  if (!isRecord(value)) return null
  if (value.schemaVersion !== TASK_SUPERVISOR_SCHEMA_VERSION) return null
  if (
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.taskListId) ||
    !isFiniteNumber(value.createdAt) ||
    !isFiniteNumber(value.updatedAt) ||
    !isRecord(value.plan) ||
    !isRecord(value.state)
  ) {
    return null
  }

  const plan = value.plan
  const state = value.state
  if (
    plan.graphSchemaVersion !== TASK_GRAPH_SCHEMA_VERSION ||
    (plan.strategy !== 'serial' && plan.strategy !== 'parallel') ||
    !isFiniteNumber(plan.maxParallelism) ||
    !Array.isArray(plan.taskIds) ||
    !Array.isArray(plan.groups) ||
    !isValidation(plan.validation) ||
    !RUN_STATUSES.has(state.status as SupervisorRunStatus) ||
    !(
      state.currentGroupIndex === null ||
      isFiniteNumber(state.currentGroupIndex)
    ) ||
    !Array.isArray(state.completedTaskIds) ||
    !Array.isArray(state.blockedTaskIds) ||
    !isValidation(state.validation) ||
    !isFiniteNumber(state.lastObservedAt)
  ) {
    return null
  }

  if (
    !plan.taskIds.every(isNonEmptyString) ||
    !state.completedTaskIds.every(isNonEmptyString) ||
    !state.blockedTaskIds.every(isNonEmptyString) ||
    !plan.groups.every(
      group =>
        isRecord(group) &&
        isFiniteNumber(group.index) &&
        (group.kind === 'serial' || group.kind === 'parallel') &&
        Array.isArray(group.taskIds) &&
        group.taskIds.every(isNonEmptyString),
    )
  ) {
    return null
  }

  return clone(value as SupervisorRun)
}

function readRun(args: {
  id: string
  taskListId: string
  rootDir?: string
}): SupervisorRun | null {
  const path = getTaskSupervisorRunPath(args)
  if (!existsSync(path)) return null
  try {
    return parseRun(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}

function writeRun(run: SupervisorRun, rootDir?: string): SupervisorRun {
  const persisted = clone(run)
  atomicWriteJson(
    getTaskSupervisorRunPath({
      id: persisted.id,
      taskListId: persisted.taskListId,
      rootDir,
    }),
    persisted,
  )
  return persisted
}

function compareTaskIds(
  taskOrder: ReadonlyMap<string, number>,
  left: string,
  right: string,
): number {
  const leftOrder = taskOrder.get(left) ?? Number.MAX_SAFE_INTEGER
  const rightOrder = taskOrder.get(right) ?? Number.MAX_SAFE_INTEGER
  if (leftOrder !== rightOrder) return leftOrder - rightOrder
  return left.localeCompare(right)
}

function blockedTaskIdsFromValidation(
  validation: TaskGraphValidation,
): string[] {
  const ids = new Set<string>()
  for (const dependency of validation.missingDependencies) {
    ids.add(dependency.taskId)
  }
  for (const cycle of validation.cycles) {
    for (const taskId of cycle.slice(0, -1)) ids.add(taskId)
  }
  for (const taskId of validation.duplicateTaskIds) ids.add(taskId)
  return [...ids].sort((left, right) => left.localeCompare(right))
}

function planGroups(args: {
  graph: TaskGraphSnapshot
  strategy: SupervisorRunStrategy
  maxParallelism: number
}): SupervisorRunGroup[] {
  if (!args.graph.validation.valid) return []

  const taskOrder = new Map(
    args.graph.tasks.map((task, index) => [task.id, index]),
  )
  const taskIds = args.graph.tasks
    .filter(task => task.status !== 'completed')
    .map(task => task.id)
  const remaining = new Set(taskIds)
  const prerequisites = new Map<string, Set<string>>()

  for (const taskId of taskIds) prerequisites.set(taskId, new Set())
  for (const edge of args.graph.edges) {
    if (!remaining.has(edge.to)) continue
    if (remaining.has(edge.from)) prerequisites.get(edge.to)?.add(edge.from)
  }

  const groups: SupervisorRunGroup[] = []
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter(taskId => {
        const dependencies = prerequisites.get(taskId) ?? new Set<string>()
        return [...dependencies].every(
          dependencyId => !remaining.has(dependencyId),
        )
      })
      .sort((left, right) => compareTaskIds(taskOrder, left, right))

    // Validation already rejects cycles, but retain a safe no-progress guard in
    // case an imported run contains a malformed graph snapshot.
    if (ready.length === 0) return []

    if (args.strategy === 'serial') {
      for (const taskId of ready) {
        groups.push({
          index: groups.length,
          kind: 'serial',
          taskIds: [taskId],
        })
        remaining.delete(taskId)
      }
      continue
    }

    for (let start = 0; start < ready.length; start += args.maxParallelism) {
      const taskIdsForGroup = ready.slice(start, start + args.maxParallelism)
      groups.push({
        index: groups.length,
        kind: 'parallel',
        taskIds: taskIdsForGroup,
      })
      for (const taskId of taskIdsForGroup) remaining.delete(taskId)
    }
  }

  return groups
}

function createPlan(args: {
  graph: TaskGraphSnapshot
  strategy: SupervisorRunStrategy
  maxParallelism: number
}): SupervisorRunPlan {
  return {
    graphSchemaVersion: TASK_GRAPH_SCHEMA_VERSION,
    strategy: args.strategy,
    maxParallelism: args.maxParallelism,
    taskIds: args.graph.tasks
      .filter(task => task.status !== 'completed')
      .map(task => task.id),
    groups: planGroups(args),
    validation: clone(args.graph.validation),
  }
}

function initialState(args: {
  graph: TaskGraphSnapshot
  plan: SupervisorRunPlan
  now: number
}): SupervisorRunState {
  const completedTaskIds = args.graph.tasks
    .filter(task => task.status === 'completed')
    .map(task => task.id)
  const blockedTaskIds = blockedTaskIdsFromValidation(args.graph.validation)
  const allPlannedCompleted = args.plan.taskIds.every(taskId =>
    completedTaskIds.includes(taskId),
  )
  const status: SupervisorRunStatus = allPlannedCompleted
    ? 'completed'
    : args.graph.validation.valid
      ? 'planned'
      : 'blocked'
  const currentGroupIndex =
    status === 'planned' && args.plan.groups.length > 0 ? 0 : null

  return {
    status,
    currentGroupIndex,
    completedTaskIds,
    blockedTaskIds,
    validation: clone(args.graph.validation),
    lastObservedAt: args.now,
    ...(status === 'blocked'
      ? {
          reason:
            'Task graph has missing dependencies, duplicate IDs, or cycles.',
        }
      : {}),
  }
}

function clampParallelism(value: number | undefined): number {
  if (value === undefined) return 4
  if (!Number.isFinite(value) || value < 1) {
    throw new Error('maxParallelism must be a positive finite number.')
  }
  return Math.max(1, Math.floor(value))
}

function firstIncompleteGroupIndex(
  groups: readonly SupervisorRunGroup[],
  completedTaskIds: ReadonlySet<string>,
): number | null {
  const group = groups.find(item =>
    item.taskIds.some(taskId => !completedTaskIds.has(taskId)),
  )
  return group?.index ?? null
}

function buildRefreshedState(args: {
  run: SupervisorRun
  graph: TaskGraphSnapshot
  now: number
}): SupervisorRunState {
  if (args.run.state.status === 'cancelled') {
    return {
      ...args.run.state,
      validation: clone(args.graph.validation),
      lastObservedAt: args.now,
    }
  }

  const tasksById = new Map(args.graph.tasks.map(task => [task.id, task]))
  const completedTaskIds = args.run.plan.taskIds.filter(
    taskId => tasksById.get(taskId)?.status === 'completed',
  )
  const missingPlannedTaskIds = args.run.plan.taskIds.filter(
    taskId => !tasksById.has(taskId),
  )
  const blockedTaskIds = [
    ...new Set([
      ...blockedTaskIdsFromValidation(args.graph.validation),
      ...missingPlannedTaskIds,
    ]),
  ].sort((left, right) => left.localeCompare(right))
  const allPlannedCompleted =
    args.run.plan.taskIds.length === completedTaskIds.length
  const hasInProgressTask = args.run.plan.taskIds.some(
    taskId => tasksById.get(taskId)?.status === 'in_progress',
  )

  let status: SupervisorRunStatus = 'planned'
  let reason: string | undefined
  if (allPlannedCompleted) {
    status = 'completed'
  } else if (blockedTaskIds.length > 0 || !args.graph.validation.valid) {
    status = 'blocked'
    reason = 'Task graph changed and now needs user intervention.'
  } else if (hasInProgressTask) {
    status = 'running'
  }

  return {
    status,
    currentGroupIndex:
      status === 'planned' || status === 'running'
        ? firstIncompleteGroupIndex(
            args.run.plan.groups,
            new Set(completedTaskIds),
          )
        : null,
    completedTaskIds,
    blockedTaskIds,
    validation: clone(args.graph.validation),
    lastObservedAt: args.now,
    ...(reason ? { reason } : {}),
  }
}

/**
 * Durable planner/state observer for an existing task list.  It has no LLM,
 * shell, worker or UI dependency, so it is safe to use from CLI, daemon and
 * future scheduler runtimes alike.
 */
export class TaskSupervisor {
  private readonly rootDir?: string
  private readonly now: () => number
  private readonly idFactory: () => string

  constructor(options: TaskSupervisorOptions = {}) {
    this.rootDir = options.rootDir
    this.now = options.now ?? (() => Date.now())
    this.idFactory = options.idFactory ?? (() => `run-${randomUUID()}`)
  }

  plan(input: PlanSupervisorRunInput = {}): SupervisorRun {
    const taskListId = input.taskListId ?? getTaskListId()
    const id = safeRunId(input.id ?? this.idFactory())
    if (this.get({ id, taskListId })) {
      throw new Error(`Supervisor run already exists: ${id}`)
    }

    const strategy = input.strategy ?? 'parallel'
    const maxParallelism = clampParallelism(input.maxParallelism)
    const graph = buildTaskGraph({ taskListId })
    const plan = createPlan({ graph, strategy, maxParallelism })
    const now = this.now()
    const run: SupervisorRun = {
      schemaVersion: TASK_SUPERVISOR_SCHEMA_VERSION,
      id,
      taskListId,
      createdAt: now,
      updatedAt: now,
      plan,
      state: initialState({ graph, plan, now }),
    }
    return writeRun(run, this.rootDir)
  }

  get(input: SupervisorRunLookup): SupervisorRun | null {
    return readRun({
      id: input.id,
      taskListId: input.taskListId ?? getTaskListId(),
      rootDir: this.rootDir,
    })
  }

  list(taskListId: string = getTaskListId()): SupervisorRun[] {
    const directory = join(
      getTaskSupervisorStorageRoot(this.rootDir),
      taskListStorageKey(taskListId),
    )
    try {
      return readdirSync(directory)
        .filter(name => name.endsWith('.json'))
        .flatMap(name => {
          const id = name.slice(0, -'.json'.length)
          const run = this.get({ id, taskListId })
          return run ? [run] : []
        })
        .sort((left, right) => right.createdAt - left.createdAt)
    } catch {
      return []
    }
  }

  refresh(input: SupervisorRunLookup): SupervisorRun {
    const taskListId = input.taskListId ?? getTaskListId()
    const existing = this.get({ id: input.id, taskListId })
    if (!existing) throw new Error(`Supervisor run not found: ${input.id}`)

    const graph = buildTaskGraph({ taskListId })
    const now = this.now()
    const refreshed: SupervisorRun = {
      ...existing,
      updatedAt: now,
      state: buildRefreshedState({
        run: existing,
        graph,
        now,
      }),
    }
    return writeRun(refreshed, this.rootDir)
  }

  cancel(input: CancelSupervisorRunInput): SupervisorRun {
    const taskListId = input.taskListId ?? getTaskListId()
    const existing = this.get({ id: input.id, taskListId })
    if (!existing) throw new Error(`Supervisor run not found: ${input.id}`)
    if (existing.state.status === 'completed') {
      throw new Error('A completed supervisor run cannot be cancelled.')
    }

    const now = this.now()
    const cancelled: SupervisorRun = {
      ...existing,
      updatedAt: now,
      state: {
        ...existing.state,
        status: 'cancelled',
        currentGroupIndex: null,
        lastObservedAt: now,
        ...(input.reason ? { reason: input.reason.trim() } : {}),
      },
    }
    return writeRun(cancelled, this.rootDir)
  }
}

/** Convenience one-shot planner for callers that do not need a supervisor instance. */
export function planSupervisorRun(
  input: PlanSupervisorRunInput & TaskSupervisorOptions = {},
): SupervisorRun {
  const { rootDir, now, idFactory, ...planInput } = input
  return new TaskSupervisor({ rootDir, now, idFactory }).plan(planInput)
}

export function getSupervisorRun(
  input: SupervisorRunLookup & Pick<TaskSupervisorOptions, 'rootDir'>,
): SupervisorRun | null {
  return new TaskSupervisor({ rootDir: input.rootDir }).get(input)
}

export function listSupervisorRuns(
  input: ListSupervisorRunsInput = {},
): SupervisorRun[] {
  return new TaskSupervisor({ rootDir: input.rootDir }).list(input.taskListId)
}

export function refreshSupervisorRun(
  input: SupervisorRunLookup & TaskSupervisorOptions,
): SupervisorRun {
  return new TaskSupervisor({
    rootDir: input.rootDir,
    now: input.now,
    idFactory: input.idFactory,
  }).refresh(input)
}

export function cancelSupervisorRun(
  input: CancelSupervisorRunInput & TaskSupervisorOptions,
): SupervisorRun {
  return new TaskSupervisor({
    rootDir: input.rootDir,
    now: input.now,
    idFactory: input.idFactory,
  }).cancel(input)
}
