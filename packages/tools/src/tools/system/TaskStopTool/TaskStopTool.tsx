import { z } from 'zod'
import { Tool } from '@kode/tool-interface/Tool'
import { DESCRIPTION, PROMPT, TOOL_NAME_FOR_PROMPT } from './prompt'
import {
  getOwnedBackgroundTaskSnapshot,
  killBackgroundTask,
} from '#core/tasks/backgroundRegistry'
import { getCwd } from '#core/utils/state'
import { getKodeAgentSessionId } from '#protocol/utils/kodeAgentSessionId'

function getOwnedTask(taskId: string) {
  return getOwnedBackgroundTaskSnapshot({
    taskId,
    cwd: getCwd(),
    sessionId: getKodeAgentSessionId(),
  })
}

const inputSchema = z.strictObject({
  task_id: z
    .string()
    .optional()
    .describe('The ID of the background task to stop'),
  shell_id: z.string().optional().describe('Deprecated: use task_id instead'),
})

type Input = z.infer<typeof inputSchema>
type Output = {
  message: string
  task_id: string
  task_type: 'local_bash' | 'local_agent'
}

function resolveTaskId(input: Input): string | null {
  return input.task_id ?? input.shell_id ?? null
}

export const TaskStopTool = {
  name: TOOL_NAME_FOR_PROMPT,
  async description() {
    return DESCRIPTION
  },
  userFacingName() {
    return 'Stop Task'
  },
  inputSchema,
  isReadOnly() {
    return false
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
    return resolveTaskId(input)
  },
  renderResultForAssistant(output: Output) {
    return JSON.stringify(output)
  },
  async validateInput(input: Input) {
    const taskId = resolveTaskId(input)
    if (!taskId) {
      return {
        result: false,
        message: 'Missing required parameter: task_id',
        errorCode: 1,
      }
    }

    const task = getOwnedTask(taskId)
    if (task) {
      if (task.status === 'running') return { result: true }

      return {
        result: false,
        message: `Task ${taskId} is not running (status: ${task.status})`,
        errorCode: 3,
      }
    }

    return {
      result: false,
      message: `No task found with ID: ${taskId}`,
      errorCode: 1,
    }
  },
  async *call(input: Input) {
    const taskId = resolveTaskId(input)
    if (!taskId) throw new Error('Missing required parameter: task_id')

    const task = getOwnedTask(taskId)
    if (!task) {
      throw new Error(`No task found with ID: ${taskId}`)
    }

    if (task.status !== 'running') {
      throw new Error(
        `Task ${taskId} is not running, so cannot be stopped (status: ${task.status})`,
      )
    }

    const killed = killBackgroundTask(taskId)
    const output: Output = {
      message: killed
        ? `Successfully stopped task: ${taskId} (${task.description})`
        : `No task found with ID: ${taskId}`,
      task_id: taskId,
      task_type: task.taskType,
    }
    yield {
      type: 'result',
      data: output,
      resultForAssistant: this.renderResultForAssistant(output),
    }
  },
} satisfies Tool<typeof inputSchema, Output>
