import { BunShell } from '#runtime/shell'
import { resolve } from 'node:path'
import type { BackgroundProcess } from '#runtime/shell/types'
import {
  appendTaskOutput,
  flushTaskOutput,
  getTaskOutputFilePath,
  readTaskOutput,
  readTaskOutputTail,
  readTaskOutputTailLines,
  touchTaskOutputFile,
} from '#runtime/taskOutputStore'
import {
  getBackgroundAgentTaskSnapshot,
  killBackgroundAgentTask,
  listBackgroundAgentTaskSnapshots,
  waitForBackgroundAgentTask,
  type BackgroundAgentTask,
  type BackgroundAgentGuidance,
} from '#core/utils/backgroundTasks'

export type BackgroundTaskType = 'local_bash' | 'local_agent'
export type BackgroundTaskStatus =
  'running' | 'pending' | 'completed' | 'failed' | 'killed'

type BackgroundTaskSnapshotBase = {
  taskId: string
  taskType: BackgroundTaskType
  status: BackgroundTaskStatus
  description: string
  cwd: string
  sessionId?: string
  outputFile: string
  startedAt: number
  completedAt?: number
}

export type BackgroundShellTaskSnapshot = BackgroundTaskSnapshotBase & {
  taskType: 'local_bash'
  command: string
  exitCode: number | null
  stdoutLineCount: number
  stderrLineCount: number
}

export type BackgroundAgentTaskSnapshot = BackgroundTaskSnapshotBase & {
  taskType: 'local_agent'
  parentTaskId?: string
  parentToolUseId?: string
  subagentType?: string
  model?: string
  prompt: string
  error?: string
  resultText?: string
  retrieved?: boolean
  lastActivityAt?: number
  turnCount: number
  pendingGuidanceCount: number
  appliedGuidanceCount: number
  lastGuidance?: BackgroundAgentGuidance
}

export type BackgroundTaskSnapshot =
  BackgroundShellTaskSnapshot | BackgroundAgentTaskSnapshot

export type BackgroundTaskCounts = {
  total: number
  running: number
  bash: { total: number; running: number }
  agents: { total: number; running: number }
}

export function getBackgroundShellStatus(task: {
  code: number | null
  killed: boolean
  interrupted: boolean
}): BackgroundTaskStatus {
  if (task.killed) return 'killed'
  if (task.code === null && !task.interrupted) return 'running'
  return task.code === 0 ? 'completed' : 'failed'
}

function toShellTaskSnapshot(
  task: BackgroundProcess,
): BackgroundShellTaskSnapshot {
  return {
    taskId: task.id,
    taskType: 'local_bash',
    status: getBackgroundShellStatus(task),
    description: task.command,
    cwd: task.cwd,
    ...(task.sessionId ? { sessionId: task.sessionId } : {}),
    command: task.command,
    exitCode: task.code,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    outputFile: task.outputFile || getTaskOutputFilePath(task.id),
    stdoutLineCount: task.stdoutLineCount,
    stderrLineCount: task.stderrLineCount,
  }
}

function toAgentTaskSnapshot(
  task: BackgroundAgentTask,
): BackgroundAgentTaskSnapshot {
  const guidance = task.guidance ?? []
  const lastGuidance = guidance.at(-1)
  return {
    taskId: task.agentId,
    taskType: 'local_agent',
    status: task.status,
    description: task.description,
    cwd: task.cwd,
    ...(task.sessionId ? { sessionId: task.sessionId } : {}),
    outputFile: getTaskOutputFilePath(task.agentId),
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    parentTaskId: task.parentAgentId,
    parentToolUseId: task.parentToolUseId,
    subagentType: task.subagentType,
    model: task.model,
    prompt: task.prompt,
    error: task.error,
    resultText: task.resultText,
    retrieved: task.retrieved,
    lastActivityAt: task.lastActivityAt,
    turnCount: task.turnCount ?? 0,
    pendingGuidanceCount: guidance.filter(
      item => item.status === 'queued' || item.status === 'claimed',
    ).length,
    appliedGuidanceCount: guidance.filter(item => item.status === 'applied')
      .length,
    ...(lastGuidance ? { lastGuidance: { ...lastGuidance } } : {}),
  }
}

export function listBackgroundTaskSnapshots(): BackgroundTaskSnapshot[] {
  const shell = BunShell.getInstance()
  return [
    ...listBackgroundAgentTaskSnapshots().map(toAgentTaskSnapshot),
    ...shell.listBackgroundShells().map(toShellTaskSnapshot),
  ]
}

export function isBackgroundTaskOwnedBy(args: {
  task: BackgroundTaskSnapshot
  cwd: string
  sessionId: string
}): boolean {
  if (resolve(args.task.cwd) !== resolve(args.cwd)) return false
  // Missing ownership metadata must fail closed. Current task launch paths
  // always capture the session, and exposing a legacy task by workspace alone
  // would let another daemon session inspect or control it by guessing its ID.
  return Boolean(args.task.sessionId && args.task.sessionId === args.sessionId)
}

export function listOwnedBackgroundTaskSnapshots(args: {
  cwd: string
  sessionId: string
}): BackgroundTaskSnapshot[] {
  return listBackgroundTaskSnapshots().filter(task =>
    isBackgroundTaskOwnedBy({ task, ...args }),
  )
}

export function getOwnedBackgroundTaskSnapshot(args: {
  taskId: string
  cwd: string
  sessionId: string
}): BackgroundTaskSnapshot | null {
  const task = getBackgroundTaskSnapshot(args.taskId)
  return task && isBackgroundTaskOwnedBy({ task, ...args }) ? task : null
}

export function summarizeBackgroundTaskSnapshots(
  tasks: readonly BackgroundTaskSnapshot[],
): BackgroundTaskCounts {
  const shells = tasks.filter(task => task.taskType === 'local_bash')
  const agents = tasks.filter(task => task.taskType === 'local_agent')
  const runningShells = shells.filter(task => task.status === 'running').length
  const runningAgents = agents.filter(task => task.status === 'running').length

  return {
    total: tasks.length,
    running: runningShells + runningAgents,
    bash: { total: shells.length, running: runningShells },
    agents: { total: agents.length, running: runningAgents },
  }
}

export function getBackgroundTaskCounts(): BackgroundTaskCounts {
  return summarizeBackgroundTaskSnapshots(listBackgroundTaskSnapshots())
}

export function hasBackgroundTasks(): boolean {
  return getBackgroundTaskCounts().total > 0
}

export function getBackgroundTaskSnapshot(
  taskId: string,
): BackgroundTaskSnapshot | null {
  const agent = getBackgroundAgentTaskSnapshot(taskId)
  if (agent) return toAgentTaskSnapshot(agent)

  const shell = BunShell.getInstance()
    .listBackgroundShells()
    .find(task => task.id === taskId)
  if (shell) return toShellTaskSnapshot(shell)

  return null
}

export function killBackgroundTask(taskId: string): boolean {
  const task = getBackgroundTaskSnapshot(taskId)
  if (!task || task.status !== 'running') return false

  if (task.taskType === 'local_agent') {
    return killBackgroundAgentTask(taskId)
  }

  return BunShell.getInstance().killBackgroundShell(taskId)
}

export function getBackgroundTaskOutputFilePath(taskId: string): string {
  return getTaskOutputFilePath(taskId)
}

export function touchBackgroundTaskOutputFile(taskId: string): string {
  return touchTaskOutputFile(taskId)
}

export function appendBackgroundTaskOutput(
  taskId: string,
  chunk: string,
): void {
  appendTaskOutput(taskId, chunk)
}

export function flushBackgroundTaskOutput(taskId: string): void {
  flushTaskOutput(taskId)
}

export function readBackgroundTaskOutput(taskId: string): string {
  return readTaskOutput(taskId)
}

export function readBackgroundTaskOutputTail(
  taskId: string,
  maxBytes: number,
): { content: string; wasTruncated: boolean } {
  return readTaskOutputTail(taskId, maxBytes)
}

export function readBackgroundTaskOutputTailLines(
  taskId: string,
  maxLines: number,
): string[] {
  return readTaskOutputTailLines(taskId, maxLines)
}

export async function waitForBackgroundTaskSnapshot(args: {
  taskId: string
  timeoutMs: number
  signal: AbortSignal
}): Promise<BackgroundTaskSnapshot | null> {
  const initial = getBackgroundTaskSnapshot(args.taskId)
  if (!initial) return null
  if (initial.status !== 'running' && initial.status !== 'pending') {
    return initial
  }

  if (initial.taskType === 'local_agent') {
    await waitForBackgroundAgentTask(args.taskId, args.timeoutMs, args.signal)
    return getBackgroundTaskSnapshot(args.taskId)
  }

  const startedAt = Date.now()
  while (Date.now() - startedAt < args.timeoutMs) {
    if (args.signal.aborted) return getBackgroundTaskSnapshot(args.taskId)
    const task = getBackgroundTaskSnapshot(args.taskId)
    if (!task) return null
    if (task.status !== 'running' && task.status !== 'pending') return task
    await new Promise(resolve => setTimeout(resolve, 100))
  }

  return getBackgroundTaskSnapshot(args.taskId)
}

export const __backgroundTaskRegistryForTests = {
  toAgentTaskSnapshot,
  toShellTaskSnapshot,
}
