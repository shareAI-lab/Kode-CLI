import React from 'react'
import { Box, Text } from 'ink'

import { getAgentByType, type AgentConfig } from '@kode/agent'
import {
  acquireWorkspaceLease,
  executeAgentPlanEvents,
  planAgentExecution,
  type AgentExecutionOutcome,
  type AgentWorkItem,
} from '#core/automation'
import { createAssistantMessage } from '#core/utils/messages'
import { getCwd } from '#core/utils/state'
import { getTheme } from '#core/utils/theme'
import type {
  Tool,
  ToolUseContext,
  ValidationResult,
} from '@kode/tool-interface/Tool'
import { callTaskTool } from '#tools/tools/ai/TaskTool/call'
import type { Output as TaskOutput } from '#tools/tools/ai/TaskTool/schema'

import {
  inputSchema,
  type Input,
  type Output,
  type VoiceIntent,
} from './schema'

const READ_ONLY_TOOL_NAMES = new Set([
  'LS',
  'Glob',
  'Grep',
  'Lsp',
  'Read',
  'WebSearch',
  'WebFetch',
  'ListMcpResources',
  'ReadMcpResource',
  'MCPSearch',
])

function toolName(spec: string): string {
  return spec
    .slice(0, spec.indexOf('(') >= 0 ? spec.indexOf('(') : undefined)
    .trim()
}

export function isVerifiedReadOnlyAgent(config: AgentConfig): boolean {
  return (
    config.tools !== '*' &&
    config.tools.length > 0 &&
    config.tools.every(spec => READ_ONLY_TOOL_NAMES.has(toolName(spec)))
  )
}

function toWorkItems(input: Input): AgentWorkItem[] {
  return input.tasks.map(task => ({
    id: task.id,
    agentType: task.subagent_type,
    prompt: task.prompt,
    mode: task.mode,
    dependsOn: task.depends_on,
  }))
}

function isVoiceTurn(context?: ToolUseContext): boolean {
  return context?.options?.voiceTurn === true
}

function formatVoiceTaskPrompt(args: {
  task: Input['tasks'][number]
  voiceIntent: VoiceIntent
}): string {
  const bulletList = (items: readonly string[]) =>
    items.map(item => `- ${item.trim()}`).join('\n')
  return [
    'This task originated from a voice conversation. The raw transcript is intentionally not provided.',
    'Work only from the organized intent below; do not broaden scope or invent missing targets.',
    '',
    `Organized user goal:\n${args.voiceIntent.summary.trim()}`,
    `Explicit facts and constraints:\n${bulletList(args.voiceIntent.explicit_facts)}`,
    ...(args.voiceIntent.assumptions.length > 0
      ? [
          `Conversation-based assumptions:\n${bulletList(args.voiceIntent.assumptions)}`,
        ]
      : []),
    ...(args.task.resume_agent_id
      ? [
          'Continuation rule: this task resumes an earlier agent transcript. The organized goal and constraints above are current and supersede any older assumptions, conclusions, or planned actions.',
        ]
      : []),
    '',
    `Assigned subtask:\n${args.task.prompt.trim()}`,
    'If this brief is insufficient, report the exact missing information instead of guessing or taking extra action.',
  ].join('\n')
}

type TaskBatchToolUseContext = ToolUseContext & {
  __testCallTaskTool?: typeof callTaskTool
}

function taskForId(input: Input, id: string): Input['tasks'][number] {
  const task = input.tasks.find(item => item.id.trim() === id)
  if (!task) throw new Error(`Scheduled task ${id} is no longer present.`)
  return task
}

function summarizeTaskOutput(output: TaskOutput): {
  agentId: string
  summary: string
} {
  if (output.status === 'async_launched') {
    throw new Error('A batch task unexpectedly launched in the background.')
  }
  if (output.status === 'failed') {
    throw new Error(output.error || 'The delegated agent failed.')
  }
  const summary = output.content
    .map(block => block.text)
    .join('\n')
    .replace(/\s+/gu, ' ')
    .trim()
  return {
    agentId: output.agentId,
    summary: summary.length > 600 ? `${summary.slice(0, 599)}…` : summary,
  }
}

async function runTask(args: {
  task: Input['tasks'][number]
  context: TaskBatchToolUseContext
  voiceIntent?: VoiceIntent
}): Promise<BatchTaskResult> {
  // The plan is only local to this TaskBatch invocation. Acquire a canonical
  // workspace lease at the actual child-execution boundary so batches and
  // sessions cannot overlap a potential writer in the same checkout.
  const workspaceLease = await acquireWorkspaceLease({
    workspacePath: getCwd(),
    mode: args.task.mode,
    signal: args.context.abortController.signal,
  })
  try {
    let result: TaskOutput | null = null
    const isolatedContext: ToolUseContext = {
      ...args.context,
      options: {
        ...args.context.options,
        ...(args.voiceIntent ? { voiceIntentPrepared: true } : {}),
      },
      // Each nested run has a distinct logical tool-use id. This prevents
      // transcript/progress collisions while retaining the parent permission
      // context, working directory, cancellation signal, and model policy.
      toolUseId: `${args.context.toolUseId ?? 'TaskBatch'}:${args.task.id}`,
    }
    const taskRunner = args.context.__testCallTaskTool ?? callTaskTool
    for await (const event of taskRunner(
      {
        description: args.task.description,
        prompt: args.voiceIntent
          ? formatVoiceTaskPrompt({
              task: args.task,
              voiceIntent: args.voiceIntent,
            })
          : args.task.prompt,
        subagent_type: args.task.subagent_type,
        ...(args.task.resume_agent_id
          ? { resume: args.task.resume_agent_id }
          : {}),
        model: args.task.model,
        max_turns: args.task.max_turns,
        run_in_background: false,
      },
      isolatedContext,
    )) {
      if (event.type === 'result') result = event.data
    }
    if (!result) throw new Error(`Task ${args.task.id} ended without a result.`)
    return {
      ...summarizeTaskOutput(result),
      resumed: Boolean(args.task.resume_agent_id),
    }
  } finally {
    await workspaceLease.release()
  }
}

export async function validateTaskBatchInput(
  input: Input,
  context?: ToolUseContext,
): Promise<ValidationResult> {
  if (isVoiceTurn(context)) {
    if (!input.voice_intent) {
      return {
        result: false,
        message:
          'Voice-originated delegation requires voice_intent with a normalized summary, explicit facts, assumptions, and no unresolved questions.',
      }
    }
    if (input.voice_intent.unresolved_questions.length > 0) {
      return {
        result: false,
        message:
          'Voice intent still has unresolved questions. Ask the user for clarification before dispatching any agent task.',
      }
    }
  }
  const plan = planAgentExecution(toWorkItems(input), {
    maxParallelism: input.max_parallelism,
  })
  if (!plan.valid) return { result: false, message: plan.errors.join(' ') }

  for (const task of input.tasks) {
    const agent = await getAgentByType(task.subagent_type)
    if (!agent) {
      return {
        result: false,
        message: `Agent type '${task.subagent_type}' was not found for task '${task.id}'.`,
      }
    }
    if (task.mode === 'read' && !isVerifiedReadOnlyAgent(agent)) {
      return {
        result: false,
        message:
          `Task '${task.id}' declares read mode, but agent '${task.subagent_type}' is not provably read-only. ` +
          'Use a read-only agent such as Explore/Plan, or declare this task as write mode so it is serialized.',
      }
    }
  }
  return { result: true }
}

function renderResultForAssistant(output: Output): string {
  return [
    `Agent batch ${output.status}.`,
    ...(output.voiceIntentSummary
      ? [`Organized voice intent: ${output.voiceIntentSummary}`]
      : []),
    ...output.tasks.map(task => {
      if (task.status === 'completed') {
        return `[${task.id}] completed${task.resumed ? ' (resumed)' : ''} (${task.agentId ?? 'agent'}): ${task.summary ?? 'No summary.'}`
      }
      return `[${task.id}] ${task.status}: ${task.reason ?? 'No details.'}`
    }),
  ].join('\n')
}

type BatchTaskResult = { agentId: string; summary: string; resumed: boolean }

function outputTaskForOutcome(
  outcome: AgentExecutionOutcome<BatchTaskResult>,
): Output['tasks'][number] {
  if (outcome.status === 'completed') {
    return {
      id: outcome.id,
      status: 'completed',
      agentId: outcome.value.agentId,
      ...(outcome.value.resumed ? { resumed: true } : {}),
      summary: outcome.value.summary,
    }
  }
  if (outcome.status === 'failed') {
    return {
      id: outcome.id,
      status: 'failed',
      reason:
        outcome.error instanceof Error ? outcome.error.message : 'Task failed.',
    }
  }
  return { id: outcome.id, status: 'blocked', reason: outcome.reason }
}

function progressMessage(value: string) {
  return createAssistantMessage(`<tool-progress>${value}</tool-progress>`)
}

export const TaskBatchTool = {
  name: 'TaskBatch',
  inputSchema,
  async description() {
    return 'Run an already clarified dependency-aware agent batch. Only explicitly read-only agents can run concurrently; write-capable work is serialized and still uses normal subagent permissions.'
  },
  async prompt() {
    return [
      'Use TaskBatch only after the user intent and each task target are clear.',
      'For independent investigation, use one or more read tasks with explicitly read-only agents (for example Explore or Plan).',
      'Declare any task that may edit files, run commands, publish, or use an agent with an unrestricted/unknown tool list as write; write tasks are serialized.',
      'Use depends_on for true data dependencies. Do not use this tool to avoid normal permissions or ask the user to approve an unclear action.',
      'For a voice-originated request, include voice_intent. It must contain a normalized summary, only explicit facts/constraints, bounded assumptions, and an empty unresolved_questions array. Do not delegate raw ASR wording.',
      'Use resume_agent_id only when the user explicitly asks to continue a known, no-longer-running agent. The new task prompt and voice intent must restate the current objective because they override old transcript assumptions. Do not use resume_agent_id to message or interrupt an active background agent.',
    ].join('\n')
  },
  userFacingName() {
    return 'Task batch'
  },
  async isEnabled() {
    return true
  },
  isReadOnly(input?: Input) {
    return Boolean(input?.tasks.every(task => task.mode === 'read'))
  },
  workspaceMutationScope(input?: Input, output?: Output) {
    const hasWriteTask = input?.tasks.some(task => task.mode === 'write')
    const failedWriteTask = input?.tasks.some(
      task =>
        task.mode === 'write' &&
        output?.tasks.some(
          result => result.id === task.id.trim() && result.status === 'failed',
        ),
    )
    // Before execution, a write batch is conservatively parent-owned. After
    // successful child execution the delegated verification receipts own it;
    // a failed writer may have left partial mutations for the parent to gate.
    return hasWriteTask && (!output || failedWriteTask)
      ? ('direct' as const)
      : ('delegated' as const)
  },
  isConcurrencySafe(input?: Input) {
    return Boolean(input?.tasks.every(task => task.mode === 'read'))
  },
  needsPermissions() {
    return false
  },
  validateInput: validateTaskBatchInput,
  renderToolUseMessage(input: Input) {
    const resumeCount = input.tasks.filter(task => task.resume_agent_id).length
    return `Scheduling ${input.tasks.length} agent task${input.tasks.length === 1 ? '' : 's'}${resumeCount > 0 ? ` (${resumeCount} continuation${resumeCount === 1 ? '' : 's'})` : ''}`
  },
  renderToolResultMessage(output: Output) {
    const theme = getTheme()
    return (
      <Box flexDirection="column">
        <Text
          color={output.status === 'completed' ? theme.text : theme.warning}
        >
          Agent batch {output.status}
        </Text>
        {output.voiceIntentSummary ? (
          <Text dimColor wrap="wrap">
            Organized intent: {output.voiceIntentSummary}
          </Text>
        ) : null}
        {output.tasks.map(task => (
          <Text key={task.id} dimColor={task.status === 'completed'}>
            {task.status === 'completed' ? '✓' : '•'} {task.id}: {task.status}
            {task.resumed ? ' (resumed)' : ''}
            {task.reason ? ` — ${task.reason}` : ''}
          </Text>
        ))}
      </Box>
    )
  },
  renderResultForAssistant,
  async *call(input: Input, context: TaskBatchToolUseContext) {
    // Tool calls normally pass through validateInput. Re-check here because
    // programmatic callers can invoke a Tool directly and must not gain a
    // concurrency or read-only classification bypass.
    const validation = await validateTaskBatchInput(input, context)
    if (!validation.result)
      throw new Error(validation.message ?? 'Invalid agent batch.')
    const plan = planAgentExecution(toWorkItems(input), {
      maxParallelism: input.max_parallelism,
    })
    if (!plan.valid) throw new Error(plan.errors.join(' '))

    const tasks: Output['tasks'] = []
    if (input.voice_intent) {
      yield {
        type: 'progress' as const,
        content: progressMessage(
          `Organized voice intent: ${input.voice_intent.summary.trim()}`,
        ),
      }
    }
    for await (const event of executeAgentPlanEvents(plan, {
      signal: context.abortController.signal,
      launch: work =>
        runTask({
          task: taskForId(input, work.id),
          context,
          voiceIntent: input.voice_intent,
        }),
    })) {
      if (event.type === 'group_started') {
        const taskNames = event.group.tasks.map(task => task.id).join(', ')
        const resumeCount = event.group.tasks.filter(
          task => taskForId(input, task.id).resume_agent_id,
        ).length
        yield {
          type: 'progress' as const,
          content: progressMessage(
            `Starting ${event.group.kind === 'parallel-read' ? 'read-only' : 'serialized write'} group ${event.group.index + 1}/${plan.groups.length}${resumeCount > 0 ? `; resuming ${resumeCount} agent${resumeCount === 1 ? '' : 's'}` : ''}: ${taskNames}`,
          ),
        }
      } else if (event.type === 'task_finished') {
        const task = outputTaskForOutcome(event.outcome)
        tasks.push(task)
        yield {
          type: 'progress' as const,
          content: progressMessage(
            task.status === 'completed'
              ? `Completed agent task: ${task.id}`
              : `${task.status === 'failed' ? 'Failed' : 'Blocked'} agent task: ${task.id}. ${task.reason ?? ''}`,
          ),
        }
      }
    }
    const output: Output = {
      status: tasks.every(task => task.status === 'completed')
        ? 'completed'
        : 'partial',
      ...(input.voice_intent
        ? { voiceIntentSummary: input.voice_intent.summary }
        : {}),
      groups: plan.groups.map(group => ({
        index: group.index,
        kind: group.kind,
        taskIds: group.tasks.map(task => task.id),
      })),
      tasks: tasks.sort(
        (left, right) =>
          input.tasks.findIndex(task => task.id.trim() === left.id) -
          input.tasks.findIndex(task => task.id.trim() === right.id),
      ),
    }
    yield {
      type: 'result' as const,
      data: output,
      resultForAssistant: renderResultForAssistant(output),
    }
  },
} satisfies Tool<typeof inputSchema, Output>

export const __taskBatchForTests = { toWorkItems, toolName }
