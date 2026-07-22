import type { Message as ConversationMessage } from '#core/query'

export type BackgroundAgentStatus =
  'running' | 'completed' | 'failed' | 'killed'

export type BackgroundAgentTask = {
  type: 'async_agent'
  agentId: string
  parentAgentId?: string
  parentToolUseId?: string
  subagentType?: string
  model?: string
  description: string
  prompt: string
  status: BackgroundAgentStatus
  /** Canonical workspace captured at task launch, not resolved lazily. */
  cwd: string
  /** Optional daemon session owner; absent only for legacy/in-process tasks. */
  sessionId?: string
  startedAt: number
  completedAt?: number
  error?: string
  resultText?: string
  messages: ConversationMessage[]
  retrieved?: boolean
  notified?: boolean
}

export type BackgroundAgentTaskRuntime = BackgroundAgentTask & {
  abortController: AbortController
  done: Promise<void>
}

const backgroundTasks = new Map<string, BackgroundAgentTaskRuntime>()

export function getBackgroundAgentTask(
  agentId: string,
): BackgroundAgentTaskRuntime | undefined {
  return backgroundTasks.get(agentId)
}

export function getBackgroundAgentTaskSnapshot(
  agentId: string,
): BackgroundAgentTask | undefined {
  const task = backgroundTasks.get(agentId)
  if (!task) return undefined
  const { abortController: _abortController, done: _done, ...snapshot } = task
  return snapshot
}

export function listBackgroundAgentTaskSnapshots(): BackgroundAgentTask[] {
  const out: BackgroundAgentTask[] = []
  for (const task of backgroundTasks.values()) {
    const { abortController: _abortController, done: _done, ...snapshot } = task
    out.push(snapshot)
  }
  return out
}

export function upsertBackgroundAgentTask(
  task: BackgroundAgentTaskRuntime,
): void {
  backgroundTasks.set(task.agentId, task)
}

export function markBackgroundAgentTaskRetrieved(agentId: string): void {
  const task = backgroundTasks.get(agentId)
  if (!task) return
  task.retrieved = true
}

export function markBackgroundAgentTaskNotified(agentId: string): void {
  const task = backgroundTasks.get(agentId)
  if (!task) return
  task.notified = true
}

export function killBackgroundAgentTask(agentId: string): boolean {
  const task = backgroundTasks.get(agentId)
  if (!task) return false
  if (task.status !== 'running') return false

  task.status = 'killed'
  task.completedAt = Date.now()
  task.error = 'Killed by user'
  upsertBackgroundAgentTask(task)
  task.abortController.abort()
  return true
}

export async function waitForBackgroundAgentTask(
  agentId: string,
  waitUpToMs: number,
  signal: AbortSignal,
): Promise<BackgroundAgentTaskRuntime | undefined> {
  const task = backgroundTasks.get(agentId)
  if (!task) return undefined
  if (task.status !== 'running') return task

  const timeoutPromise = new Promise<never>((_, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error('Request timed out'))
    }, waitUpToMs)
    timeoutId.unref?.()
  })

  const abortPromise = new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(new Error('Request aborted'))
      return
    }
    const onAbort = () => reject(new Error('Request aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
  })

  await Promise.race([task.done, timeoutPromise, abortPromise])
  return backgroundTasks.get(agentId)
}
