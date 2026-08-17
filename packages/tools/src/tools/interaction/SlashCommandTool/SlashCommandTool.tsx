import { z } from 'zod'
import { Tool } from '@kode/tool-interface/Tool'
import type { Message } from '#core/query'
import { createUserMessage } from '#core/utils/messages'
import { callTaskTool } from '#tools/tools/ai/TaskTool/call'
import type {
  Output as TaskToolOutput,
  TaskModel,
} from '#tools/tools/ai/TaskTool/schema'
import { TOOL_NAME_FOR_PROMPT } from './prompt'
import {
  findCommand,
  getCommandAllowedToolsFromContext,
  getCommandFlags,
  getCommandOverrides,
  parseSlashCommand,
} from './utils'

const inputSchema = z.object({
  command: z
    .string()
    .describe(
      'The slash command to execute with its arguments, e.g., "/review-pr 123"',
    ),
})

type Input = z.infer<typeof inputSchema>
type InlineOutput = {
  success: boolean
  commandName: string
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
  getPromptForCommand: (args: string) => Promise<Array<{ content: unknown }>>
  context?: string
  agent?: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  return value as Record<string, unknown>
}

function isPromptLikeCommand(value: unknown): value is PromptLikeCommand {
  const record = asRecord(value)
  return (
    record?.type === 'prompt' &&
    typeof record.name === 'string' &&
    typeof record.getPromptForCommand === 'function'
  )
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

function getCommandName(cmd: PromptLikeCommand): string {
  const userFacing =
    typeof cmd.userFacingName === 'function' ? cmd.userFacingName() : ''
  return userFacing || cmd.name
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

function getRawModelSetting(cmd: unknown): string | undefined {
  const record = asRecord(cmd)
  return typeof record?.model === 'string' ? record.model : undefined
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

export const SlashCommandTool = {
  name: TOOL_NAME_FOR_PROMPT,
  async description(input?: Input) {
    const command = input?.command
    return command
      ? `Execute slash command: ${command}`
      : 'Execute a slash command'
  },
  userFacingName() {
    return 'SlashCommand'
  },
  inputSchema,
  isReadOnly() {
    return false
  },
  workspaceMutationScope(_input?: Input, output?: Output) {
    // Prompt expansion does not itself write files. Any later direct tool use,
    // or a forked Task child, is responsible for its own verification gate.
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
    return `Execute a slash command within the main conversation

How slash commands work:
When you use this tool or when a user types a slash command, you will see <command-message>{name} is running…</command-message> followed by the expanded prompt. For example, if .kode/commands/foo.md contains "Print today's date", then /foo expands to that prompt in the next message. (Legacy compatibility: .claude/commands/*.md is also supported.)

Usage:
- \`command\` (required): The slash command to execute, including any arguments
- Example: \`command: "/review-pr 123"\`

IMPORTANT: Only use this tool for custom slash commands that are available in the current host. Do NOT use for:
- Built-in CLI commands (like /help, /clear, etc.)
- Commands you think might exist but are not available

Notes:
- When a user requests multiple slash commands, execute each one sequentially and check for <command-message>{name} is running…</command-message> to verify each has been processed
- Do not invoke a command that is already running. For example, if you see <command-message>foo is running…</command-message>, do NOT use this tool with "/foo" - process the expanded prompt in the following message
- If a user's command is not available, ask them to check the slash command file and consult the docs.
`
  },
  renderToolUseMessage({ command }: Input, _options: { verbose: boolean }) {
    return command || ''
  },
  renderResultForAssistant(output: Output) {
    if ('status' in output && output.status === 'forked') {
      const result = (output.result || '').trim()
      const resultBlock = result ? `\n\nResult:\n${result}` : ''
      return `Slash command "/${output.commandName}" ${output.success ? 'completed' : 'failed'} (forked execution).${resultBlock}\n\nAgent ID: ${output.agentId}`
    }
    return `Launching command: /${output.commandName}`
  },
  async validateInput({ command }: Input, context) {
    const parsed = parseSlashCommand(command)
    if (!parsed) {
      return {
        result: false,
        message: `Invalid slash command format: ${command}`,
        errorCode: 1,
      }
    }

    const commands = Array.isArray(context?.options?.commands)
      ? context.options.commands
      : []

    const cmd = findCommand(parsed.commandName, commands)
    if (!cmd) {
      return {
        result: false,
        message: `Unknown slash command: ${parsed.commandName}`,
        errorCode: 2,
      }
    }

    const flags = getCommandFlags(cmd)
    if (flags.disableModelInvocation) {
      return {
        result: false,
        message: `Slash command ${parsed.commandName} cannot be used with ${TOOL_NAME_FOR_PROMPT} tool due to disable-model-invocation`,
        errorCode: 4,
      }
    }

    if (flags.disableNonInteractive) {
      return {
        result: false,
        message: `Slash command ${parsed.commandName} cannot be used with ${TOOL_NAME_FOR_PROMPT} tool because it is non-interactive`,
        errorCode: 6,
      }
    }

    if (!isPromptLikeCommand(cmd)) {
      return {
        result: false,
        message: `Slash command ${parsed.commandName} is not a prompt-based command`,
        errorCode: 5,
      }
    }

    return { result: true }
  },
  async *call({ command }: Input, context) {
    const parsed = parseSlashCommand(command)
    if (!parsed) {
      throw new Error(`Invalid slash command format: ${command}`)
    }

    const commands = Array.isArray(context.options?.commands)
      ? context.options.commands
      : []
    const cmdUnknown = findCommand(parsed.commandName, commands)
    if (!cmdUnknown) {
      throw new Error(`Unknown slash command: ${parsed.commandName}`)
    }
    const flags = getCommandFlags(cmdUnknown)
    if (flags.disableModelInvocation) {
      throw new Error(
        `Slash command ${parsed.commandName} cannot be used with ${TOOL_NAME_FOR_PROMPT} tool due to disable-model-invocation`,
      )
    }
    if (flags.disableNonInteractive) {
      throw new Error(
        `Slash command ${parsed.commandName} cannot be used with ${TOOL_NAME_FOR_PROMPT} tool because it is non-interactive`,
      )
    }
    if (!isPromptLikeCommand(cmdUnknown)) {
      throw new Error(
        `Slash command ${parsed.commandName} is not a prompt-based command. Use /${parsed.commandName} directly in the main conversation.`,
      )
    }

    const cmd = cmdUnknown
    const prompt = await cmd.getPromptForCommand(parsed.args)

    const commandNameForMeta = getCommandName(cmd)
    const { progressMessage, allowedTools, model, maxThinkingTokens } =
      getCommandOverrides(cmd)

    if (getCommandContext(cmd) === 'fork') {
      const slashPrompt = prompt
        .map(msg => contentToText(msg.content))
        .join('\n')
        .trim()

      const agentType = getCommandAgent(cmd) ?? 'general-purpose'
      const taskModel = toTaskToolModel(getRawModelSetting(cmd))

      const taskInput = {
        description: commandNameForMeta,
        prompt: slashPrompt,
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
          `Forked slash command execution produced no result: ${parsed.commandName}`,
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
        commandName: parsed.commandName,
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

    const expandedMessages: Message[] = prompt.map(msg => {
      const userMessage = createUserMessage(contentToText(msg.content))
      userMessage.options = {
        ...userMessage.options,
        isCustomCommand: true,
        commandName: commandNameForMeta,
        commandArgs: parsed.args,
      }
      return userMessage
    })

    const metaMessage =
      createUserMessage(`<command-name>${commandNameForMeta}</command-name>
<command-message>${commandNameForMeta} is ${progressMessage}…</command-message>
<command-args>${parsed.args}</command-args>`)

    const output: InlineOutput = {
      success: true,
      commandName: parsed.commandName,
      status: 'inline',
    }

    yield {
      type: 'result' as const,
      data: output,
      resultForAssistant: this.renderResultForAssistant(output),
      newMessages: [metaMessage, ...expandedMessages],
      contextModifier:
        allowedTools.length > 0 || model || maxThinkingTokens !== undefined
          ? {
              modifyContext(ctx) {
                const next = { ...ctx }

                if (allowedTools.length > 0) {
                  const prev = getCommandAllowedToolsFromContext(next)
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
