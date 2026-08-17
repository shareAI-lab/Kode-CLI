import { z } from 'zod'
import { resolve } from 'node:path'

import type { Tool, ToolUseContext } from '@kode/tool-interface/Tool'
import {
  BACKGROUND_AGENT_GUIDANCE_MAX_BYTES,
  BackgroundAgentGuidanceError,
  guideBackgroundAgentTask,
} from '#core/utils/backgroundTasks'
import { getBackgroundTaskSnapshot } from '#core/tasks/backgroundRegistry'
import { getCwd } from '#core/utils/state'
import { getKodeAgentSessionId } from '#protocol/utils/kodeAgentSessionId'
import { DESCRIPTION, PROMPT, TOOL_NAME_FOR_PROMPT } from './prompt'

const inputSchema = z.strictObject({
  task_id: z.string().min(1).describe('Running background agent ID'),
  message: z
    .string()
    .min(1)
    .describe('Follow-up guidance to apply at the next model-turn boundary'),
})

type Input = z.infer<typeof inputSchema>
type Output = {
  task_id: string
  guidance_id: string
  status: 'queued'
  queued_at: number
  pending_guidance: number
  delivery: 'next_model_turn_boundary'
}

function safeError(error: unknown): string {
  if (error instanceof BackgroundAgentGuidanceError) return error.message
  return 'The background agent guidance could not be queued.'
}

function taskScopeError(
  task: ReturnType<typeof getBackgroundTaskSnapshot>,
  context?: ToolUseContext,
): string | null {
  if (!task || task.taskType !== 'local_agent') return null
  if (!context) return 'Task guidance requires an execution context.'
  if (resolve(task.cwd) !== resolve(getCwd())) {
    return 'Task guidance is limited to the current workspace.'
  }
  const currentSessionId = getKodeAgentSessionId()
  if (!task.sessionId || task.sessionId !== currentSessionId) {
    return 'Task guidance is limited to the owning session.'
  }
  const callerAgentId = context.agentId?.trim() || 'main'
  const parentAgentId = task.parentTaskId?.trim() || 'main'
  if (callerAgentId !== parentAgentId) {
    return 'Only the agent that launched this task may guide it.'
  }
  return null
}

export const TaskGuideTool = {
  name: TOOL_NAME_FOR_PROMPT,
  inputSchema,
  async description() {
    return DESCRIPTION
  },
  userFacingName() {
    return 'Guide Task'
  },
  async isEnabled() {
    return true
  },
  isReadOnly() {
    return false
  },
  isConcurrencySafe() {
    return true
  },
  needsPermissions() {
    return true
  },
  async prompt() {
    return PROMPT
  },
  renderToolUseMessage(input: Input) {
    const preview = input.message.replace(/\s+/gu, ' ').trim()
    return `${input.task_id}: ${preview.length > 120 ? `${preview.slice(0, 119)}…` : preview}`
  },
  renderResultForAssistant(output: Output) {
    return JSON.stringify(output)
  },
  async validateInput(input: Input, context?: ToolUseContext) {
    const message = input.message.trim()
    if (!message || message.includes('\u0000')) {
      return {
        result: false,
        message: 'Guidance must contain non-empty text without NUL characters.',
      }
    }
    if (
      Buffer.byteLength(message, 'utf8') > BACKGROUND_AGENT_GUIDANCE_MAX_BYTES
    ) {
      return {
        result: false,
        message: `Guidance exceeds ${BACKGROUND_AGENT_GUIDANCE_MAX_BYTES} UTF-8 bytes.`,
      }
    }
    const task = getBackgroundTaskSnapshot(input.task_id)
    if (!task) {
      return {
        result: false,
        message: `No task found with ID: ${input.task_id}`,
      }
    }
    if (task.taskType !== 'local_agent') {
      return {
        result: false,
        message: 'Runtime guidance can only be sent to a background agent.',
      }
    }
    if (task.status !== 'running') {
      return {
        result: false,
        message: `Task ${input.task_id} is not running (status: ${task.status}).`,
      }
    }
    const scopeError = taskScopeError(task, context)
    if (scopeError) return { result: false, message: scopeError }
    return { result: true }
  },
  async *call(input: Input, context: ToolUseContext) {
    try {
      const scopeError = taskScopeError(
        getBackgroundTaskSnapshot(input.task_id),
        context,
      )
      if (scopeError) {
        throw new BackgroundAgentGuidanceError(
          'task_scope_mismatch',
          scopeError,
        )
      }
      const guidance = guideBackgroundAgentTask({
        agentId: input.task_id,
        body: input.message,
      })
      const snapshot = getBackgroundTaskSnapshot(input.task_id)
      const output: Output = {
        task_id: input.task_id,
        guidance_id: guidance.guidanceId,
        status: 'queued',
        queued_at: guidance.queuedAt,
        pending_guidance:
          snapshot?.taskType === 'local_agent'
            ? snapshot.pendingGuidanceCount
            : 1,
        delivery: 'next_model_turn_boundary',
      }
      yield {
        type: 'result' as const,
        data: output,
        resultForAssistant: this.renderResultForAssistant(output),
      }
    } catch (error) {
      throw new Error(safeError(error))
    }
  },
} satisfies Tool<typeof inputSchema, Output>
