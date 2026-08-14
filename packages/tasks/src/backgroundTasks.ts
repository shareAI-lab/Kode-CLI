import type { Message as ConversationMessage } from '@kode/message-utils/types'

export const BACKGROUND_AGENT_GUIDANCE_MAX_BYTES = 16 * 1024
export const BACKGROUND_AGENT_GUIDANCE_QUEUE_LIMIT = 64
export const BACKGROUND_AGENT_GUIDANCE_BATCH_LIMIT = 8
export const BACKGROUND_AGENT_GUIDANCE_BATCH_BYTES = 64 * 1024
const BACKGROUND_AGENT_GUIDANCE_HISTORY_LIMIT = 128

export type BackgroundAgentGuidanceStatus = 'queued' | 'claimed' | 'applied'

export type BackgroundAgentGuidance = {
  guidanceId: string
  body: string
  queuedAt: number
  status: BackgroundAgentGuidanceStatus
  claimedAt?: number
  appliedAt?: number
}

export class BackgroundAgentGuidanceError extends Error {
  constructor(
    readonly code:
      | 'task_not_found'
      | 'task_not_running'
      | 'invalid_guidance'
      | 'guidance_too_large'
      | 'guidance_queue_full'
      | 'task_scope_mismatch',
    message: string,
  ) {
    super(message)
    this.name = 'BackgroundAgentGuidanceError'
  }
}

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
  /** Last observed model/tool-stream activity, distinct from parent guidance. */
  lastActivityAt?: number
  /** Provider round trips consumed by this background agent. */
  turnCount?: number
  /** Bounded parent-to-agent control history. */
  guidance?: BackgroundAgentGuidance[]
}

export type BackgroundAgentTaskRuntime = BackgroundAgentTask & {
  abortController: AbortController
  done: Promise<void>
}

const backgroundTasks = new Map<string, BackgroundAgentTaskRuntime>()

function copyGuidance(
  guidance: readonly BackgroundAgentGuidance[] | undefined,
): BackgroundAgentGuidance[] | undefined {
  return guidance?.map(item => ({ ...item }))
}

function requireRunningAgent(agentId: string): BackgroundAgentTaskRuntime {
  const task = backgroundTasks.get(agentId)
  if (!task) {
    throw new BackgroundAgentGuidanceError(
      'task_not_found',
      `No background agent found with ID: ${agentId}`,
    )
  }
  if (task.status !== 'running') {
    throw new BackgroundAgentGuidanceError(
      'task_not_running',
      `Background agent ${agentId} is not running (status: ${task.status}).`,
    )
  }
  return task
}

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
  return {
    ...snapshot,
    messages: [...snapshot.messages],
    guidance: copyGuidance(snapshot.guidance),
  }
}

export function listBackgroundAgentTaskSnapshots(): BackgroundAgentTask[] {
  const out: BackgroundAgentTask[] = []
  for (const task of backgroundTasks.values()) {
    const { abortController: _abortController, done: _done, ...snapshot } = task
    out.push({
      ...snapshot,
      messages: [...snapshot.messages],
      guidance: copyGuidance(snapshot.guidance),
    })
  }
  return out
}

export function upsertBackgroundAgentTask(
  task: BackgroundAgentTaskRuntime,
): void {
  backgroundTasks.set(task.agentId, task)
}

export function updateBackgroundAgentActivity(args: {
  agentId: string
  at?: number
  turnCount?: number
}): void {
  const task = backgroundTasks.get(args.agentId)
  if (!task) return
  task.lastActivityAt = Math.floor(args.at ?? Date.now())
  if (
    args.turnCount !== undefined &&
    Number.isSafeInteger(args.turnCount) &&
    args.turnCount >= 0
  ) {
    task.turnCount = args.turnCount
  }
  upsertBackgroundAgentTask(task)
}

/** Queue bounded parent guidance for delivery at the next model-turn boundary. */
export function guideBackgroundAgentTask(args: {
  agentId: string
  body: string
  now?: number
}): BackgroundAgentGuidance {
  const task = requireRunningAgent(args.agentId)
  const body = args.body.trim()
  if (!body || body.includes('\u0000')) {
    throw new BackgroundAgentGuidanceError(
      'invalid_guidance',
      'Guidance must contain non-empty text without NUL characters.',
    )
  }
  if (Buffer.byteLength(body, 'utf8') > BACKGROUND_AGENT_GUIDANCE_MAX_BYTES) {
    throw new BackgroundAgentGuidanceError(
      'guidance_too_large',
      `Guidance exceeds ${BACKGROUND_AGENT_GUIDANCE_MAX_BYTES} UTF-8 bytes.`,
    )
  }

  const history = task.guidance ?? []
  const pendingCount = history.filter(
    item => item.status === 'queued' || item.status === 'claimed',
  ).length
  if (pendingCount >= BACKGROUND_AGENT_GUIDANCE_QUEUE_LIMIT) {
    throw new BackgroundAgentGuidanceError(
      'guidance_queue_full',
      `Agent guidance queue is full (${BACKGROUND_AGENT_GUIDANCE_QUEUE_LIMIT} items).`,
    )
  }

  const queuedAt = Math.floor(args.now ?? Date.now())
  if (!Number.isSafeInteger(queuedAt) || queuedAt <= 0) {
    throw new BackgroundAgentGuidanceError(
      'invalid_guidance',
      'Guidance timestamp must be a positive safe integer.',
    )
  }
  const guidance: BackgroundAgentGuidance = {
    guidanceId: crypto.randomUUID(),
    body,
    queuedAt,
    status: 'queued',
  }
  task.guidance = [...history, guidance].slice(
    -BACKGROUND_AGENT_GUIDANCE_HISTORY_LIMIT,
  )
  upsertBackgroundAgentTask(task)
  return { ...guidance }
}

export function claimBackgroundAgentGuidance(args: {
  agentId: string
  now?: number
  maxItems?: number
  maxBytes?: number
}): BackgroundAgentGuidance[] {
  const task = backgroundTasks.get(args.agentId)
  if (!task || task.status !== 'running') return []
  const claimedAt = Math.floor(args.now ?? Date.now())
  const maxItems = Math.min(
    BACKGROUND_AGENT_GUIDANCE_BATCH_LIMIT,
    Math.max(
      1,
      Math.floor(args.maxItems ?? BACKGROUND_AGENT_GUIDANCE_BATCH_LIMIT),
    ),
  )
  const maxBytes = Math.min(
    BACKGROUND_AGENT_GUIDANCE_BATCH_BYTES,
    Math.max(
      1,
      Math.floor(args.maxBytes ?? BACKGROUND_AGENT_GUIDANCE_BATCH_BYTES),
    ),
  )
  let bytes = 0
  const claimed: BackgroundAgentGuidance[] = []
  for (const item of task.guidance ?? []) {
    if (item.status !== 'queued') continue
    const itemBytes = Buffer.byteLength(item.body, 'utf8')
    if (claimed.length >= maxItems || bytes + itemBytes > maxBytes) break
    item.status = 'claimed'
    item.claimedAt = claimedAt
    bytes += itemBytes
    claimed.push({ ...item })
  }
  if (claimed.length > 0) upsertBackgroundAgentTask(task)
  return claimed
}

export function acknowledgeBackgroundAgentGuidance(args: {
  agentId: string
  guidanceIds: readonly string[]
  now?: number
}): number {
  const task = backgroundTasks.get(args.agentId)
  if (!task) return 0
  const ids = new Set(args.guidanceIds)
  const appliedAt = Math.floor(args.now ?? Date.now())
  let applied = 0
  for (const item of task.guidance ?? []) {
    if (item.status !== 'claimed' || !ids.has(item.guidanceId)) continue
    item.status = 'applied'
    item.appliedAt = appliedAt
    applied += 1
  }
  if (applied > 0) upsertBackgroundAgentTask(task)
  return applied
}

export function releaseBackgroundAgentGuidance(args: {
  agentId: string
  guidanceIds: readonly string[]
}): number {
  const task = backgroundTasks.get(args.agentId)
  if (!task) return 0
  const ids = new Set(args.guidanceIds)
  let released = 0
  for (const item of task.guidance ?? []) {
    if (item.status !== 'claimed' || !ids.has(item.guidanceId)) continue
    item.status = 'queued'
    delete item.claimedAt
    released += 1
  }
  if (released > 0) upsertBackgroundAgentTask(task)
  return released
}

export function hasQueuedBackgroundAgentGuidance(agentId: string): boolean {
  return Boolean(
    backgroundTasks
      .get(agentId)
      ?.guidance?.some(item => item.status === 'queued'),
  )
}

export function getQueuedBackgroundAgentGuidanceIds(agentId: string): string[] {
  return (
    backgroundTasks
      .get(agentId)
      ?.guidance?.filter(item => item.status === 'queued')
      .map(item => item.guidanceId) ?? []
  )
}

function escapeGuidanceText(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
}

export function formatBackgroundAgentGuidanceForContext(
  guidance: readonly BackgroundAgentGuidance[],
): string {
  if (guidance.length === 0) return ''
  const blocks = guidance.map(
    item => `<parent-agent-guidance id="${item.guidanceId}">
${escapeGuidanceText(item.body)}
</parent-agent-guidance>`,
  )
  return `<runtime-guidance>
The main agent supplied the following guidance while this task was running. Apply it at this model-turn boundary. It may refine or redirect unfinished work, but it does not retroactively cancel tool calls that already started. If it conflicts with the original task, follow the newest explicit guidance. Do not claim that guidance was applied before this turn.
${blocks.join('\n')}
</runtime-guidance>

`
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

  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let onAbort: (() => void) | null = null

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error('Request timed out'))
    }, waitUpToMs)
    timeoutId.unref?.()
  })

  const abortPromise = new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(new Error('Request aborted'))
      return
    }
    onAbort = () => reject(new Error('Request aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
  })

  try {
    await Promise.race([task.done, timeoutPromise, abortPromise])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
  return backgroundTasks.get(agentId)
}

/** Process-global registry cleanup for isolated tests only. */
export function __removeBackgroundAgentTaskForTests(agentId: string): void {
  backgroundTasks.delete(agentId)
}
