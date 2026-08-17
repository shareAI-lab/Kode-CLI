import { z } from 'zod'
import { Tool } from '@kode/tool-interface/Tool'
import type { Message } from '#core/query'
import { createUserMessage } from '#core/utils/messages'
import { callTaskTool } from '#tools/tools/ai/TaskTool/call'
import type {
  TaskModel,
  Output as TaskToolOutput,
} from '#tools/tools/ai/TaskTool/schema'
import { TOOL_NAME_FOR_PROMPT } from './prompt'
import { loadSkillCommandsFromProvider } from './skillCommandProvider'
const inputSchema = z.object({
  skill: z
    .string()
    .describe(
      'The skill name (no arguments). Use a value from <available_skills>.',
    ),
  args: z
    .string()
    .optional()
    .describe('Optional arguments for the skill (freeform text)'),
})

type Input = z.infer<typeof inputSchema>
type InlineOutput = {
  success: boolean
  commandName: string
  allowedTools?: string[]
  model?: string
  status?: 'inline'
}

type ForkedOutput = {
  success: boolean
  commandName: string
  status: 'forked'
  agentId: string
  result: string
}

type Output = InlineOutput | ForkedOutput

type PromptLikeCommand = {
  type: 'prompt'
  name: string
  userFacingName?: () => string
  aliases?: string[]
  getPromptForCommand: (args: string) => Promise<Array<{ content: unknown }>>
  context?: string
  agent?: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  return value as Record<string, unknown>
}
function isTextContentBlock(
  value: unknown,
): value is { type: 'text'; text: string } {
  const record = asRecord(value)
  return record?.type === 'text' && typeof record.text === 'string'
}
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(b => (isTextContentBlock(b) ? b.text : ''))
    .join('\n')
    .trim()
}
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isPromptLikeCommand(value: unknown): value is PromptLikeCommand {
  const record = asRecord(value)
  return (
    record?.type === 'prompt' &&
    typeof record.name === 'string' &&
    typeof record.getPromptForCommand === 'function'
  )
}

function getCommandName(cmd: PromptLikeCommand): string {
  const userFacing =
    typeof cmd.userFacingName === 'function' ? cmd.userFacingName() : ''
  return userFacing || cmd.name
}

function getDisableModelInvocation(cmd: unknown): boolean {
  const record = asRecord(cmd)
  return record?.disableModelInvocation === true
}

function getAllowedTools(cmd: unknown): string[] {
  const record = asRecord(cmd)
  return isStringArray(record?.allowedTools) ? record.allowedTools : []
}

function getCommandContext(cmd: unknown): 'fork' | undefined {
  const record = asRecord(cmd)
  return record?.context === 'fork' ? 'fork' : undefined
}

function getCommandAgent(cmd: unknown): string | undefined {
  const record = asRecord(cmd)
  const raw = record?.agent
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed ? trimmed : undefined
}

function getModelSetting(cmd: unknown): string | undefined {
  const record = asRecord(cmd)
  return normalizeCommandModelName(record?.model)
}

function getRawModelSetting(cmd: unknown): string | undefined {
  const record = asRecord(cmd)
  return typeof record?.model === 'string' ? record.model : undefined
}

function getMaxThinkingTokens(cmd: unknown): number | undefined {
  const record = asRecord(cmd)
  return typeof record?.maxThinkingTokens === 'number'
    ? record.maxThinkingTokens
    : undefined
}

function normalizeCommandModelName(model: unknown): string | undefined {
  if (typeof model !== 'string') return undefined
  const trimmed = model.trim()
  if (!trimmed || trimmed === 'inherit') return undefined
  if (trimmed === 'haiku') return 'quick'
  if (trimmed === 'sonnet') return 'task'
  if (trimmed === 'opus') return 'main'
  return trimmed
}

function toTaskToolModel(rawModel: string | undefined): TaskModel | undefined {
  if (!rawModel) return undefined
  const trimmed = rawModel.trim()
  if (!trimmed || trimmed === 'inherit') return undefined
  if (trimmed === 'haiku' || trimmed === 'quick') return 'haiku'
  if (trimmed === 'sonnet' || trimmed === 'task') return 'sonnet'
  if (trimmed === 'opus' || trimmed === 'main') return 'opus'
  return undefined
}

function mergeUniqueStrings(a: unknown, b: string[]): string[] {
  const left = Array.isArray(a) ? a.filter(x => typeof x === 'string') : []
  return [...new Set([...left, ...b])]
}

export const SkillTool = {
  name: TOOL_NAME_FOR_PROMPT,
  async description(input?: Input) {
    const skill = input?.skill
    return skill ? `Execute skill: ${skill}` : 'Execute a skill'
  },
  userFacingName() {
    return 'Skill'
  },
  inputSchema,
  isReadOnly() {
    return false
  },
  workspaceMutationScope(_input?: Input, output?: Output) {
    // Expanded in-context messages are assessed when their tools run; forked
    // skills execute through Task and own their verification in the child.
    return output?.success === false
      ? ('direct' as const)
      : ('delegated' as const)
  },
  isConcurrencySafe() {
    return false
  },
  async isEnabled() {
    return true
  },
  needsPermissions() {
    return true
  },
  async prompt() {
    // Compatibility note: include a best-effort listing of available skills/commands,
    // truncated by a simple size budget.
    type CustomCommand = {
      type: 'prompt'
      name: string
      description: string
      isEnabled: boolean
      isHidden: boolean
      userFacingName: () => string
      filePath?: string
      scope?: 'user' | 'project' | string
      isSkill?: boolean
      disableModelInvocation?: boolean
    }

    const MAX_AVAILABLE_SKILLS_CHARS = 8000

    async function loadCommands(): Promise<CustomCommand[]> {
      const cmds = await loadSkillCommandsFromProvider()
      return cmds.filter((cmd): cmd is CustomCommand => {
        if (!cmd || typeof cmd !== 'object') return false
        const record = cmd as Record<string, unknown>
        return (
          record.type === 'prompt' &&
          typeof record.name === 'string' &&
          typeof record.description === 'string' &&
          typeof record.isEnabled === 'boolean' &&
          typeof record.isHidden === 'boolean' &&
          typeof record.userFacingName === 'function'
        )
      })
    }

    function formatSkillBlock(cmd: CustomCommand): string {
      const name = cmd.userFacingName()
      const description = cmd.description
      const location = cmd.filePath ?? ''
      return `<skill>
<name>
${name}
</name>
<description>
${description}
</description>
<location>
${location}
</location>
</skill>`
    }

    function buildAvailableSkillsSection(cmds: CustomCommand[]): string {
      const eligible = cmds.filter(
        cmd => cmd.isEnabled && cmd.disableModelInvocation !== true,
      )

      const ordered = [...eligible].sort((a, b) => {
        const scopeRank = (scope: CustomCommand['scope']) =>
          scope === 'project' ? 0 : scope === 'user' ? 1 : 2
        const scopeDelta = scopeRank(a.scope) - scopeRank(b.scope)
        if (scopeDelta !== 0) return scopeDelta

        const skillDelta =
          (a.isSkill === true ? 0 : 1) - (b.isSkill === true ? 0 : 1)
        if (skillDelta !== 0) return skillDelta

        return a.userFacingName().localeCompare(b.userFacingName())
      })

      const blocks: string[] = []
      let totalChars = 0

      for (const cmd of ordered) {
        const block = formatSkillBlock(cmd)
        totalChars += block.length + 1
        if (totalChars > MAX_AVAILABLE_SKILLS_CHARS) break
        blocks.push(block)
      }

      const joined = blocks.join('\n')
      const truncated =
        ordered.length > blocks.length
          ? `\n<!-- Showing ${blocks.length} of ${ordered.length} skills due to token limits -->`
          : ''

      return `${joined}${truncated}`
    }

    const commands = await loadCommands()
    const availableSkills = buildAvailableSkillsSection(commands)

    return `Execute a skill within the main conversation

<skills_instructions>
When users ask you to perform tasks, check if any of the available skills below can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge.

When users ask you to run a "slash command" or reference "/<something>" (e.g., "/commit", "/review-pr"), they are referring to a skill. Use this tool to invoke the corresponding skill.

<example>
User: "run /commit"
Assistant: [Calls Skill tool with skill: "commit"]
</example>

How to invoke:
- Use this tool with the skill name and optional arguments
- Examples:
  - \`skill: "pdf"\` - invoke the pdf skill
  - \`skill: "commit", args: "-m 'Fix bug'"\` - invoke with arguments
  - \`skill: "review-pr", args: "123"\` - invoke with arguments
  - \`skill: "ms-office-suite:pdf"\` - invoke using fully qualified name

Important:
- When a skill is relevant, you must invoke this tool IMMEDIATELY as your first action
- NEVER just announce or mention a skill in your text response without actually calling this tool
- This is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task
- Only use skills listed in <available_skills> below
- Do not invoke a skill that is already running
- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)
</skills_instructions>

<available_skills>
${availableSkills}
</available_skills>
`
  },
  renderToolUseMessage({ skill }: Input, _options: { verbose: boolean }) {
    return skill || ''
  },
  renderResultForAssistant(output: Output) {
    if ('status' in output && output.status === 'forked') {
      const result = (output.result || '').trim()
      const resultBlock = result ? `\n\nResult:\n${result}` : ''
      return `Skill "${output.commandName}" ${output.success ? 'completed' : 'failed'} (forked execution).${resultBlock}\n\nAgent ID: ${output.agentId}`
    }
    return `Launching skill: ${output.commandName}`
  },
  async validateInput({ skill }: Input, context) {
    const raw = skill.trim()
    if (!raw) {
      return {
        result: false,
        message: `Invalid skill format: ${skill}`,
        errorCode: 1,
      }
    }
    const skillName = raw.startsWith('/') ? raw.slice(1) : raw

    const commands = Array.isArray(context?.options?.commands)
      ? context.options.commands
      : []
    const cmd = findCommand(skillName, commands)
    if (!cmd) {
      return {
        result: false,
        message: `Unknown skill: ${skillName}. No matching skill is available in the current host.`,
        errorCode: 2,
      }
    }

    if (getDisableModelInvocation(cmd)) {
      return {
        result: false,
        message: `Skill ${skillName} cannot be used with ${TOOL_NAME_FOR_PROMPT} tool due to disable-model-invocation`,
        errorCode: 4,
      }
    }

    if (!isPromptLikeCommand(cmd)) {
      return {
        result: false,
        message: `Skill ${skillName} is not a prompt-based skill`,
        errorCode: 5,
      }
    }

    return { result: true }
  },
  async *call({ skill, args }: Input, context) {
    const raw = skill.trim()
    const skillName = raw.startsWith('/') ? raw.slice(1) : raw

    const commands = Array.isArray(context.options?.commands)
      ? context.options.commands
      : []
    const cmd = findCommand(skillName, commands)
    if (!cmd) {
      throw new Error(`Unknown skill: ${skillName}`)
    }
    if (getDisableModelInvocation(cmd)) {
      throw new Error(
        `Skill ${skillName} cannot be used with ${TOOL_NAME_FOR_PROMPT} tool due to disable-model-invocation`,
      )
    }
    if (!isPromptLikeCommand(cmd)) {
      throw new Error(`Skill ${skillName} is not a prompt-based skill`)
    }

    const allowedTools = getAllowedTools(cmd)
    const model = getModelSetting(cmd)
    const maxThinkingTokens = getMaxThinkingTokens(cmd)

    if (getCommandContext(cmd) === 'fork') {
      const promptMessages = await cmd.getPromptForCommand(args ?? '')
      const skillPrompt = promptMessages
        .map(msg => contentToText(msg.content))
        .join('\n')
        .trim()

      const agentType = getCommandAgent(cmd) ?? 'general-purpose'
      const taskModel = toTaskToolModel(getRawModelSetting(cmd))

      const taskInput = {
        description: getCommandName(cmd),
        prompt: skillPrompt,
        subagent_type: agentType,
        ...(taskModel ? { model: taskModel } : null),
      }

      let taskResult: TaskToolOutput | null = null
      const taskContext = {
        ...context,
        options: {
          ...(context.options ?? {}),
          forceForkContext: true,
          commandAllowedTools: mergeUniqueStrings(
            context.options?.commandAllowedTools,
            allowedTools,
          ),
        },
      } as any

      for await (const evt of callTaskTool(taskInput as any, taskContext)) {
        if (evt.type === 'progress') {
          yield { type: 'progress' as const, content: evt.content }
          continue
        }
        if (evt.type === 'result') {
          taskResult = evt.data as TaskToolOutput
        }
      }

      if (!taskResult) {
        throw new Error(
          `Forked skill execution produced no result: ${skillName}`,
        )
      }

      const agentId = taskResult.agentId
      const resultText =
        taskResult.status === 'completed' || taskResult.status === 'failed'
          ? taskResult.content
              .map(b => b.text)
              .join('\n')
              .trim()
          : ''

      const output: ForkedOutput = {
        success: taskResult.status === 'completed',
        commandName: skillName,
        status: 'forked',
        agentId,
        result: resultText,
      }

      yield {
        type: 'result' as const,
        data: output,
        resultForAssistant: this.renderResultForAssistant(output),
      }
      return
    }

    const prompt = await cmd.getPromptForCommand(args ?? '')
    const expandedMessages: Message[] = prompt.map(msg => {
      const userMessage = createUserMessage(contentToText(msg.content))
      userMessage.options = {
        ...userMessage.options,
        isCustomCommand: true,
        commandName: getCommandName(cmd),
        commandArgs: args ?? '',
      }
      return userMessage
    })

    const output: InlineOutput = {
      success: true,
      commandName: skillName,
      status: 'inline',
      allowedTools: allowedTools.length > 0 ? allowedTools : undefined,
      model,
    }

    yield {
      type: 'result' as const,
      data: output,
      resultForAssistant: this.renderResultForAssistant(output),
      newMessages: expandedMessages,
      contextModifier:
        allowedTools.length > 0 || model || maxThinkingTokens !== undefined
          ? {
              modifyContext(ctx) {
                const next = { ...ctx }

                if (allowedTools.length > 0) {
                  const prev = next.options?.commandAllowedTools ?? []
                  next.options = {
                    ...(next.options || {}),
                    commandAllowedTools: [
                      ...new Set([...prev, ...allowedTools]),
                    ],
                  }
                }

                if (model) {
                  next.options = { ...(next.options || {}), model }
                }

                if (maxThinkingTokens !== undefined) {
                  next.options = {
                    ...(next.options || {}),
                    maxThinkingTokens,
                  }
                }

                return next
              },
            }
          : undefined,
    }
  },
} satisfies Tool<typeof inputSchema, Output>

function findCommand(commandName: string, commands: unknown[]): unknown | null {
  for (const candidate of commands) {
    const record = asRecord(candidate)
    if (!record) continue
    if (record.name === commandName) return candidate
    if (typeof record.userFacingName === 'function') {
      try {
        if (String(record.userFacingName()) === commandName) return candidate
      } catch {
        // ignore
      }
    }
    const aliases = record.aliases
    if (isStringArray(aliases) && aliases.includes(commandName)) {
      return candidate
    }
  }
  return null
}
