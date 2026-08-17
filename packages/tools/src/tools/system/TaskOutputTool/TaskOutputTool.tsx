import { z } from 'zod'
import type {
  Tool,
  ToolUseContext,
  ValidationResult,
} from '@kode/tool-interface/Tool'
import {
  getBackgroundTaskOutputFilePath,
  getOwnedBackgroundTaskSnapshot,
  readBackgroundTaskOutputTail,
  type BackgroundTaskSnapshot,
  waitForBackgroundTaskSnapshot,
} from '#core/tasks/backgroundRegistry'
import { createAssistantMessage } from '#core/utils/messages'
import { getCwd } from '#core/utils/state'
import { getKodeAgentSessionId } from '#protocol/utils/kodeAgentSessionId'
import { DESCRIPTION, PROMPT, TOOL_NAME_FOR_PROMPT } from './prompt'

const inputSchema = z.strictObject({
  task_id: z.string().describe('The task ID to get output from'),
  block: z
    .boolean()
    .optional()
    .default(true)
    .describe('Whether to wait for completion'),
  timeout: z
    .number()
    .min(0)
    .max(600000)
    .optional()
    .default(30000)
    .describe('Max wait time in ms'),
})

type Input = z.infer<typeof inputSchema>

type TaskType = 'local_bash' | 'local_agent' | 'remote_agent'
type TaskStatus = 'running' | 'pending' | 'completed' | 'failed' | 'killed'

type TaskSummary = {
  task_id: string
  task_type: TaskType
  status: TaskStatus
  description: string
  output?: string
  exitCode?: number | null
  /** Used by the engine to classify completed background shell work. */
  command?: string
  prompt?: string
  result?: string
  error?: string
}

type Output = {
  retrieval_status: 'success' | 'timeout' | 'not_ready'
  task: TaskSummary | null
}

const DEFAULT_TASK_MAX_OUTPUT_LENGTH = 100_000
const MIN_TASK_MAX_OUTPUT_LENGTH = 1_000
const MAX_TASK_MAX_OUTPUT_LENGTH = 200_000

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)))
}

function getTaskMaxOutputLength(): number {
  const raw =
    process.env.KODE_TASK_MAX_OUTPUT_LENGTH ??
    process.env.TASK_MAX_OUTPUT_LENGTH
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN
  if (!Number.isFinite(parsed) || parsed <= 0)
    return DEFAULT_TASK_MAX_OUTPUT_LENGTH
  return clampInt(
    parsed,
    MIN_TASK_MAX_OUTPUT_LENGTH,
    MAX_TASK_MAX_OUTPUT_LENGTH,
  )
}

function truncateTaskOutput(args: { taskId: string; output: string }): {
  output: string
  wasTruncated: boolean
} {
  const limit = getTaskMaxOutputLength()
  if (args.output.length <= limit)
    return { output: args.output, wasTruncated: false }

  const prefix = `[Truncated. Full output: ${getBackgroundTaskOutputFilePath(args.taskId)}]\n`
  const remaining = limit - prefix.length
  if (remaining <= 0)
    return { output: prefix.slice(0, limit), wasTruncated: true }
  return {
    output: prefix + args.output.slice(-remaining),
    wasTruncated: true,
  }
}

function normalizeTaskOutputInput(input: Input): Input {
  return input
}

function buildTaskSummaryFromSnapshot(
  snapshot: BackgroundTaskSnapshot,
): TaskSummary {
  const limit = getTaskMaxOutputLength()
  const persisted = readBackgroundTaskOutputTail(snapshot.taskId, limit)
  const fallback =
    snapshot.taskType === 'local_agent' ? snapshot.resultText || '' : ''
  const rawOutput = persisted.content || fallback
  const materializedOutput = persisted.wasTruncated
    ? `[Earlier output omitted]\n${rawOutput}`
    : rawOutput
  const { output } = truncateTaskOutput({
    taskId: snapshot.taskId,
    output: materializedOutput,
  })

  return {
    task_id: snapshot.taskId,
    task_type: snapshot.taskType,
    status: snapshot.status,
    description: snapshot.description,
    output,
    exitCode:
      snapshot.taskType === 'local_bash' ? snapshot.exitCode : undefined,
    command: snapshot.taskType === 'local_bash' ? snapshot.command : undefined,
    prompt: snapshot.taskType === 'local_agent' ? snapshot.prompt : undefined,
    result: snapshot.taskType === 'local_agent' ? output : undefined,
    error: snapshot.taskType === 'local_agent' ? snapshot.error : undefined,
  }
}

function buildTaskSummary(taskId: string): TaskSummary | null {
  const snapshot = getOwnedBackgroundTaskSnapshot({
    taskId,
    cwd: getCwd(),
    sessionId: getKodeAgentSessionId(),
  })
  return snapshot ? buildTaskSummaryFromSnapshot(snapshot) : null
}

export const TaskOutputTool = {
  name: TOOL_NAME_FOR_PROMPT,
  isTrustedExecutionTool: true,
  async description() {
    return DESCRIPTION
  },
  userFacingName() {
    return 'Task Output'
  },
  inputSchema,
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  async isEnabled() {
    return true
  },
  needsPermissions() {
    return false
  },
  async prompt() {
    return PROMPT
  },
  renderToolUseMessage(input: Input) {
    if (input.block === false) return 'non-blocking'
    return ''
  },
  renderToolUseRejectedMessage() {
    return null
  },
  renderResultForAssistant(output: Output) {
    const parts: string[] = []
    parts.push(
      `<retrieval_status>${output.retrieval_status}</retrieval_status>`,
    )

    if (output.task) {
      parts.push(`<task_id>${output.task.task_id}</task_id>`)
      parts.push(`<task_type>${output.task.task_type}</task_type>`)
      parts.push(`<status>${output.task.status}</status>`)
      if (output.task.exitCode !== undefined && output.task.exitCode !== null) {
        parts.push(`<exit_code>${output.task.exitCode}</exit_code>`)
      }
      if (output.task.output?.trim()) {
        parts.push(`<output>\n${output.task.output.trimEnd()}\n</output>`)
      }
      if (output.task.error) {
        parts.push(`<error>${output.task.error}</error>`)
      }
    }

    return parts.join('\n\n')
  },
  async validateInput(input: Input): Promise<ValidationResult> {
    if (!input.task_id) {
      return { result: false, message: 'Task ID is required', errorCode: 1 }
    }

    const snapshot = getOwnedBackgroundTaskSnapshot({
      taskId: input.task_id,
      cwd: getCwd(),
      sessionId: getKodeAgentSessionId(),
    })
    if (!snapshot) {
      return {
        result: false,
        message: `No task found with ID: ${input.task_id}`,
        errorCode: 2,
      }
    }

    return { result: true }
  },
  async *call(input: Input, context: ToolUseContext) {
    const normalized = normalizeTaskOutputInput(input)
    const taskId = normalized.task_id
    const block = normalized.block
    const timeoutMs = normalized.timeout

    const initial = buildTaskSummary(taskId)
    if (!initial) {
      throw new Error(`No task found with ID: ${taskId}`)
    }

    if (!block) {
      const isDone =
        initial.status !== 'running' && initial.status !== 'pending'
      const out: Output = {
        retrieval_status: isDone ? 'success' : 'not_ready',
        task: initial,
      }
      yield {
        type: 'result',
        data: out,
        resultForAssistant: this.renderResultForAssistant(out),
      }
      return
    }

    yield {
      type: 'progress',
      content: createAssistantMessage(
        `<tool-progress>${initial.description ? `  ${initial.description}\n` : ''}     Waiting for task (esc to give additional instructions)</tool-progress>`,
      ),
    }

    let finalTask: TaskSummary | null = null

    try {
      const snapshot = await waitForBackgroundTaskSnapshot({
        taskId,
        timeoutMs,
        signal: context.abortController.signal,
      })
      finalTask = snapshot ? buildTaskSummaryFromSnapshot(snapshot) : null
    } catch {
      finalTask = buildTaskSummary(taskId)
    }

    if (!finalTask) {
      const out: Output = { retrieval_status: 'timeout', task: null }
      yield {
        type: 'result',
        data: out,
        resultForAssistant: this.renderResultForAssistant(out),
      }
      return
    }

    if (finalTask.status === 'running' || finalTask.status === 'pending') {
      const out: Output = { retrieval_status: 'timeout', task: finalTask }
      yield {
        type: 'result',
        data: out,
        resultForAssistant: this.renderResultForAssistant(out),
      }
      return
    }

    const out: Output = { retrieval_status: 'success', task: finalTask }
    yield {
      type: 'result',
      data: out,
      resultForAssistant: this.renderResultForAssistant(out),
    }
  },
} satisfies Tool<typeof inputSchema, Output>
