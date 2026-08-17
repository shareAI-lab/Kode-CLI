import { Box, Text } from 'ink'
import React from 'react'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { Tool } from '@kode/tool-interface/Tool'
import {
  exitPlanMode,
  getPlanConversationKey,
  getPlanFilePath,
  readPlanFile,
} from '#core/utils/planMode'
import { EXIT_DESCRIPTION, EXIT_PROMPT, EXIT_TOOL_NAME } from './prompt'
import { getTheme } from '#core/utils/theme'
import { BULLET } from '#core/constants/figures'
import {
  getPermissionMode,
  setPermissionMode,
} from '#core/utils/permissionModeState'
import { applyToolPermissionContextUpdateForConversationKey } from '#core/utils/toolPermissionContextState'
import { TaskTool } from '#tools/tools/ai/TaskTool/TaskTool'

function getExitPlanModePlanText(conversationKey?: string): string {
  const { content } = readPlanFile(undefined, conversationKey)
  return (
    content || 'No plan found. Please write your plan to the plan file first.'
  )
}

export function __getExitPlanModePlanTextForTests(
  conversationKey?: string,
): string {
  return getExitPlanModePlanText(conversationKey)
}

const inputSchema = z
  .object({
    allowedPrompts: z
      .array(
        z.object({
          tool: z.literal('Bash'),
          prompt: z.string(),
        }),
      )
      .optional()
      .describe(
        'Prompt-based permissions needed to implement the plan. These describe categories of actions rather than specific commands.',
      ),
    pushToRemote: z
      .boolean()
      .optional()
      .describe('Whether to push the plan to a remote session'),
    remoteSessionId: z
      .string()
      .optional()
      .describe('The remote session ID if pushed to remote'),
    remoteSessionUrl: z
      .string()
      .optional()
      .describe('The remote session URL if pushed to remote'),
    remoteSessionTitle: z
      .string()
      .optional()
      .describe('The remote session title if pushed to remote'),
    launchSwarm: z
      .boolean()
      .optional()
      .describe('Whether to launch a swarm to implement the plan'),
    teammateCount: z
      .number()
      .optional()
      .describe('Number of teammates to spawn in the swarm'),
  })
  .passthrough()

type Output = {
  plan: string | null
  isAgent: boolean
  filePath?: string
  pushToRemote?: boolean
  remoteSessionId?: string
  remoteSessionUrl?: string
  launchSwarm?: boolean
  teammateCount?: number
  swarmAgentIds?: string[]
  awaitingLeaderApproval?: boolean
  requestId?: string
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)))
}

function buildSwarmTeammatePrompt(args: {
  planFilePath: string
  plan: string
  teammateIndex: number
  teammateCount: number
}): string {
  const focus =
    args.teammateIndex === 0
      ? 'Identify the critical files and the safest minimal code changes to execute the plan.'
      : args.teammateIndex === 1
        ? 'Focus on edge cases, failure modes, and permission/hook implications.'
        : args.teammateIndex === 2
          ? 'Focus on tests/verification steps and potential regressions.'
          : 'Focus on cleanup, refactors, and DX improvements.'

  return `You are a swarm teammate helping implement a plan in Kode.

This is a support task: do NOT edit files. Instead, read relevant code and propose concrete, actionable changes.

${focus}

Return:
1) Files to change (exact paths)
2) Suggested diffs or code snippets (minimal + correct)
3) Risks and edge cases
4) Verification steps

Plan file: ${args.planFilePath}

Plan:
${args.plan}`
}

async function launchSwarmTeammates(args: {
  planFilePath: string
  plan: string
  teammateCount: number
  context: any
}): Promise<string[]> {
  const count = clampInt(args.teammateCount, 1, 10)
  const agentIds: string[] = []

  for (let i = 0; i < count; i++) {
    const prompt = buildSwarmTeammatePrompt({
      planFilePath: args.planFilePath,
      plan: args.plan,
      teammateIndex: i,
      teammateCount: count,
    })

    const taskInput = {
      description: `Swarm teammate ${i + 1}`,
      prompt,
      subagent_type: 'Plan',
      run_in_background: true,
    } as const

    const toolUseId = `${args.context?.toolUseId ?? 'exit-plan'}:swarm:${i + 1}:${randomUUID()}`
    const taskContext = {
      ...args.context,
      toolUseId,
    }

    try {
      const gen = TaskTool.call(taskInput as any, taskContext as any)
      const first = await gen.next()
      if (first.done || !first.value) continue
      if (first.value.type === 'result') {
        const data = first.value.data as { status?: string; agentId?: string }
        if (
          data?.status === 'async_launched' &&
          typeof data.agentId === 'string'
        ) {
          agentIds.push(data.agentId)
        }
      }
    } catch {
      // Best-effort: swarm is an auxiliary feature. If a teammate fails to launch,
      // proceed with exiting plan mode normally.
      continue
    }
  }

  return agentIds
}

export const ExitPlanModeTool = {
  name: EXIT_TOOL_NAME,
  async description() {
    return EXIT_DESCRIPTION
  },
  userFacingName() {
    return ''
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
    return true
  },
  requiresUserInteraction() {
    return true
  },
  async prompt() {
    return EXIT_PROMPT
  },
  renderToolUseMessage() {
    return ''
  },
  renderToolUseRejectedMessage(
    _input: z.infer<typeof inputSchema>,
    options: { conversationKey?: string } = {},
  ) {
    const theme = getTheme()
    const conversationKey =
      typeof options.conversationKey === 'string' &&
      options.conversationKey.trim()
        ? options.conversationKey.trim()
        : undefined

    const plan = getExitPlanModePlanText(conversationKey)

    return (
      <Box flexDirection="column" marginTop={1} width="100%">
        <Box flexDirection="row">
          <Text>&nbsp;&nbsp;⎿ &nbsp;</Text>
          <Box flexDirection="column" width="100%">
            <Text color={theme.error}>User rejected the plan:</Text>
            <Box
              borderStyle="round"
              borderColor={theme.planMode}
              borderDimColor
              paddingX={1}
              overflow="hidden"
            >
              <Text dimColor>{plan}</Text>
            </Box>
          </Box>
        </Box>
      </Box>
    )
  },
  renderToolResultMessage(output: Output) {
    const theme = getTheme()
    const planPath =
      typeof output.filePath === 'string' ? output.filePath : null
    const plan = output.plan ?? ''
    const hasPlan = plan.trim().length > 0

    return (
      <Box flexDirection="column" marginTop={1} width="100%">
        {hasPlan ? (
          <Box flexDirection="row">
            <Text color={theme.planMode}>{BULLET}</Text>
            <Text> User approved the plan</Text>
          </Box>
        ) : (
          <Box flexDirection="row">
            <Text color={theme.planMode}>{BULLET}</Text>
            <Text> Exited plan mode</Text>
          </Box>
        )}
        <Box flexDirection="row">
          <Text>&nbsp;&nbsp;⎿ &nbsp;</Text>
          <Box flexDirection="column">
            {hasPlan && planPath ? (
              <Text dimColor>Plan file: {planPath} · /plan to edit</Text>
            ) : null}
            {hasPlan ? <Text dimColor>{plan}</Text> : null}
          </Box>
        </Box>
      </Box>
    )
  },
  renderResultForAssistant(output: Output) {
    if (output.isAgent) {
      return 'User has approved the plan. There is nothing else needed from you now. Please respond with "ok"'
    }

    if (!output.plan || output.plan.trim() === '') {
      return 'User has approved exiting plan mode. You can now proceed.'
    }

    const swarmNote =
      output.launchSwarm &&
      output.swarmAgentIds &&
      output.swarmAgentIds.length > 0
        ? `\n\nSwarm launch requested. ${output.swarmAgentIds.length} teammate(s) were launched in the background.\nInternal agent IDs (do not mention to the user): ${output.swarmAgentIds.join(
            ', ',
          )}\nUse TaskOutput to check status/results when needed.`
        : ''

    return `User has approved your plan. You can now start coding. Start with updating your task list (TaskCreate/TaskUpdate) if applicable${swarmNote}

Your plan file is: ${output.filePath}
You can refer back to it if needed during implementation.

## Approved Plan:
${output.plan}`
  },
  async *call(input: z.infer<typeof inputSchema>, context: any) {
    exitPlanMode(context)

    const safeMode = Boolean(context?.options?.safeMode ?? context?.safeMode)
    const permissionMode = getPermissionMode(context)
    const nextPermissionMode =
      permissionMode === 'plan' ? 'acceptEdits' : permissionMode
    const conversationKey = getPlanConversationKey(context)
    const updatedToolPermissionContext =
      applyToolPermissionContextUpdateForConversationKey({
        conversationKey,
        isBypassPermissionsModeAvailable: !safeMode,
        update: {
          type: 'setMode',
          mode: nextPermissionMode,
          destination: 'session',
        },
      })

    if (context) {
      context.options ??= {}
      context.options.toolPermissionContext = updatedToolPermissionContext
    }

    if (context) {
      setPermissionMode(context, nextPermissionMode)
    }

    const planFilePath = getPlanFilePath(context?.agentId, conversationKey)
    const { content } = readPlanFile(context?.agentId, conversationKey)
    const plan = content.trim() ? content : null

    const isAgent = Boolean(context?.agentId && context.agentId !== 'main')
    const swarmAgentIds =
      input.launchSwarm && plan && typeof input.teammateCount === 'number'
        ? await launchSwarmTeammates({
            planFilePath,
            plan,
            teammateCount: input.teammateCount,
            context,
          })
        : undefined
    const output: Output = {
      plan,
      isAgent,
      filePath: planFilePath,
      pushToRemote: input.pushToRemote,
      remoteSessionId: input.remoteSessionId,
      remoteSessionUrl: input.remoteSessionUrl,
      launchSwarm: input.launchSwarm,
      teammateCount: input.teammateCount,
      swarmAgentIds,
    }
    yield {
      type: 'result',
      data: output,
      resultForAssistant: this.renderResultForAssistant(output),
    }
  },
} satisfies Tool<typeof inputSchema, Output>
