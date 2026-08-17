import { z } from 'zod'

import type { Tool, ToolUseContext } from '@kode/tool-interface/Tool'
import {
  getOwnedBackgroundTaskSnapshot,
  listOwnedBackgroundTaskSnapshots,
  readBackgroundTaskOutputTail,
  type BackgroundTaskSnapshot,
} from '#core/tasks/backgroundRegistry'
import { getCwd } from '#core/utils/state'
import { getKodeAgentSessionId } from '#protocol/utils/kodeAgentSessionId'
import { DESCRIPTION, PROMPT, TOOL_NAME_FOR_PROMPT } from './prompt'

const inputSchema = z.strictObject({
  action: z.enum(['list', 'get']).default('list'),
  task_id: z.string().optional().describe('Required when action=get'),
  include_output: z
    .boolean()
    .optional()
    .default(false)
    .describe('Include a bounded recent output tail'),
})

type Input = z.infer<typeof inputSchema>

type TaskView = {
  task_id: string
  task_type: BackgroundTaskSnapshot['taskType']
  status: BackgroundTaskSnapshot['status']
  description: string
  parent_task_id?: string
  subagent_type?: string
  model?: string
  started_at: number
  completed_at?: number
  elapsed_ms: number
  last_activity_at?: number
  turn_count?: number
  pending_guidance?: number
  applied_guidance?: number
  latest_guidance?: {
    status: string
    queued_at: number
    applied_at?: number
    preview: string
  }
  output?: string
  output_truncated?: boolean
}

type Output = {
  action: 'list' | 'get'
  counts: { total: number; running: number; agents: number; shells: number }
  tasks: TaskView[]
}

const MAX_LIST_ITEMS = 50
const OUTPUT_TAIL_BYTES = 8 * 1024
const GUIDANCE_PREVIEW_CHARACTERS = 160

function guidancePreview(body: string): string {
  const normalized = body.replace(/\s+/gu, ' ').trim()
  const characters = Array.from(normalized)
  return characters.length <= GUIDANCE_PREVIEW_CHARACTERS
    ? normalized
    : `${characters.slice(0, GUIDANCE_PREVIEW_CHARACTERS - 1).join('')}…`
}

function taskView(
  task: BackgroundTaskSnapshot,
  includeOutput: boolean,
  now = Date.now(),
): TaskView {
  const output = includeOutput
    ? readBackgroundTaskOutputTail(task.taskId, OUTPUT_TAIL_BYTES)
    : null
  return {
    task_id: task.taskId,
    task_type: task.taskType,
    status: task.status,
    description: task.description,
    started_at: task.startedAt,
    ...(task.completedAt ? { completed_at: task.completedAt } : {}),
    elapsed_ms: Math.max(0, (task.completedAt ?? now) - task.startedAt),
    ...(task.taskType === 'local_agent'
      ? {
          ...(task.parentTaskId ? { parent_task_id: task.parentTaskId } : {}),
          ...(task.subagentType ? { subagent_type: task.subagentType } : {}),
          ...(task.model ? { model: task.model } : {}),
          ...(task.lastActivityAt
            ? { last_activity_at: task.lastActivityAt }
            : {}),
          turn_count: task.turnCount,
          pending_guidance: task.pendingGuidanceCount,
          applied_guidance: task.appliedGuidanceCount,
          ...(task.lastGuidance
            ? {
                latest_guidance: {
                  status: task.lastGuidance.status,
                  queued_at: task.lastGuidance.queuedAt,
                  preview: guidancePreview(task.lastGuidance.body),
                  ...(task.lastGuidance.appliedAt
                    ? { applied_at: task.lastGuidance.appliedAt }
                    : {}),
                },
              }
            : {}),
        }
      : {}),
    ...(output
      ? { output: output.content, output_truncated: output.wasTruncated }
      : {}),
  }
}

function counts(tasks: readonly BackgroundTaskSnapshot[]): Output['counts'] {
  return {
    total: tasks.length,
    running: tasks.filter(task => task.status === 'running').length,
    agents: tasks.filter(task => task.taskType === 'local_agent').length,
    shells: tasks.filter(task => task.taskType === 'local_bash').length,
  }
}

export const TaskMonitorTool = {
  name: TOOL_NAME_FOR_PROMPT,
  inputSchema,
  async description() {
    return DESCRIPTION
  },
  userFacingName() {
    return 'Monitor Tasks'
  },
  async isEnabled() {
    return true
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  needsPermissions() {
    return false
  },
  async prompt() {
    return PROMPT
  },
  renderToolUseMessage(input: Input) {
    return input.action === 'get' ? input.task_id : 'live topology'
  },
  renderResultForAssistant(output: Output) {
    return JSON.stringify(output)
  },
  async validateInput(input: Input, _context?: ToolUseContext) {
    if (input.action === 'get' && !input.task_id?.trim()) {
      return { result: false, message: 'task_id is required when action=get.' }
    }
    if (
      input.action === 'get' &&
      !getOwnedBackgroundTaskSnapshot({
        taskId: input.task_id!,
        cwd: getCwd(),
        sessionId: getKodeAgentSessionId(),
      })
    ) {
      return {
        result: false,
        message: `No task found with ID: ${input.task_id}`,
      }
    }
    return { result: true }
  },
  async *call(input: Input, _context: ToolUseContext) {
    const all = listOwnedBackgroundTaskSnapshots({
      cwd: getCwd(),
      sessionId: getKodeAgentSessionId(),
    })
    const selected =
      input.action === 'get'
        ? all.filter(task => task.taskId === input.task_id)
        : all
            .slice()
            .sort(
              (left, right) =>
                Number(right.status === 'running') -
                  Number(left.status === 'running') ||
                right.startedAt - left.startedAt,
            )
            .slice(0, MAX_LIST_ITEMS)
    const output: Output = {
      action: input.action,
      counts: counts(all),
      tasks: selected.map(task => taskView(task, input.include_output)),
    }
    yield {
      type: 'result' as const,
      data: output,
      resultForAssistant: this.renderResultForAssistant(output),
    }
  },
} satisfies Tool<typeof inputSchema, Output>
