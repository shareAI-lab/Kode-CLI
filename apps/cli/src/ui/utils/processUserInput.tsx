import { Box } from 'ink'
import type { Message, UserMessage } from '#core/query'
import { getCommand, hasCommand } from '#cli-commands'
import { logError } from '#core/utils/log'
import { resolve } from 'path'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { getCwd } from '#core/utils/state'
import chalk from 'chalk'
import * as React from 'react'
import { UserBashInputMessage } from '#ui-ink/components/messages/UserBashInputMessage'
import { UserBackgroundTaskInputMessage } from '#ui-ink/components/messages/UserBackgroundTaskInputMessage'
import { BashSpinner } from '#ui-ink/components/Spinner'
import { BashTool } from '#tools/tools/system/BashTool/BashTool'
import { lastX } from '#core/utils/generators'
import type { SetToolJSXFn, ToolUseContext } from '#core/tooling/Tool'
import { createAssistantMessage, createUserMessage } from '#core/utils/messages'
import { switchCwdForResume } from '#cli-utils/switchCwdForResume'
import { getMessagesForSlashCommand } from './slashCommands'
import {
  coerceImageMediaType,
  extractAssistantText,
} from './processUserInputHelpers'
import { parseBuiltinInputCommand } from './builtinInputCommands'
import type { SetForkConvoWithMessagesOnTheNextRender } from '#ui-ink/types/conversationReset'
import { interpretHashCommand } from '#ui-ink/components/PromptInput/hashCommand'
import {
  handleHashCommand,
  HASH_COMMAND_SAVE_FAILURE_MESSAGE,
} from '#core/utils/hashCommand'

export async function processUserInput(
  input: string,
  mode: 'bash' | 'background' | 'prompt' | 'koding',
  setToolJSX: SetToolJSXFn<React.ReactNode>,
  context: ToolUseContext & {
    setForkConvoWithMessagesOnTheNextRender: SetForkConvoWithMessagesOnTheNextRender
    options?: {
      isKodingRequest?: boolean
      kodingContext?: string
    }
  },
  pastedImages: Array<{
    placeholder: string
    data: string
    mediaType: string
  }> | null,
): Promise<Message[]> {
  const inputTrimmedStart = input.trimStart()
  const builtinCommand =
    mode === 'prompt' && context.options?.disableSlashCommands !== true
      ? parseBuiltinInputCommand(inputTrimmedStart)
      : null

  if (builtinCommand?.name === 'note') {
    const userMessage = createUserMessage(`<command-name>note</command-name>
        <command-message>note</command-message>
        <command-args>${builtinCommand.args}</command-args>`)

    if (!builtinCommand.args.trim()) {
      return [
        userMessage,
        createAssistantMessage(
          '<local-command-stderr>Usage: /note <text></local-command-stderr>',
        ),
      ]
    }

    try {
      const interpreted = await interpretHashCommand(builtinCommand.args)
      if (!handleHashCommand(interpreted)) {
        return [
          userMessage,
          createAssistantMessage(
            `<local-command-stderr>${HASH_COMMAND_SAVE_FAILURE_MESSAGE}</local-command-stderr>`,
          ),
        ]
      }
      return [
        userMessage,
        createAssistantMessage(
          '<local-command-stdout>Note saved to AGENTS.md.</local-command-stdout>',
        ),
      ]
    } catch (error) {
      logError(error)
      return [
        userMessage,
        createAssistantMessage(
          `<local-command-stderr>${HASH_COMMAND_SAVE_FAILURE_MESSAGE}</local-command-stderr>`,
        ),
      ]
    }
  }

  if (builtinCommand?.name === 'bash') {
    if (!builtinCommand.args.trim()) {
      return [
        createAssistantMessage(
          '<bash-stderr>Usage: /bash <command></bash-stderr>',
        ),
      ]
    }

    mode = 'bash'
    input = builtinCommand.args
  }

  // Bash commands
  if (mode === 'bash' || mode === 'background') {
    const tagName =
      mode === 'background' ? 'background-task-input' : 'bash-input'
    const userMessage = createUserMessage(`<${tagName}>${input}</${tagName}>`)

    // Special case: cd
    if (mode === 'bash' && input.startsWith('cd ')) {
      const newCwd = resolve(getCwd(), input.slice(3).trim())
      try {
        await switchCwdForResume(newCwd)
        return [
          userMessage,
          createAssistantMessage(
            `<bash-stdout>Changed directory to ${chalk.bold(`${newCwd}/`)}</bash-stdout>`,
          ),
        ]
      } catch (e) {
        logError(e)
        return [
          userMessage,
          createAssistantMessage(
            `<bash-stderr>cwd error: ${e instanceof Error ? e.message : String(e)}</bash-stderr>`,
          ),
        ]
      }
    }

    // All other bash commands
    setToolJSX({
      jsx: (
        <Box flexDirection="column" marginTop={1}>
          {mode === 'background' ? (
            <UserBackgroundTaskInputMessage
              addMargin={false}
              param={{
                text: `<background-task-input>${input}</background-task-input>`,
                type: 'text',
              }}
            />
          ) : (
            <UserBashInputMessage
              addMargin={false}
              param={{
                text: `<bash-input>${input}</bash-input>`,
                type: 'text',
              }}
            />
          )}
          <BashSpinner />
        </Box>
      ),
      shouldHidePromptInput: false,
    })
    try {
      const bashContext = {
        ...context,
        commandSource: 'user_bash_mode' as const,
      } satisfies ToolUseContext

      const validationResult = await BashTool.validateInput(
        { command: input },
        bashContext,
      )
      if (!validationResult.result) {
        return [
          userMessage,
          createAssistantMessage(validationResult.message ?? 'Invalid input'),
        ]
      }
      const lastChunk = await lastX(
        BashTool.call(
          mode === 'background'
            ? { command: input, run_in_background: true }
            : { command: input },
          bashContext,
        ),
      )
      if (lastChunk.type !== 'result') {
        return [
          userMessage,
          createAssistantMessage(
            '<bash-stderr>Command did not return a result.</bash-stderr>',
          ),
        ]
      }
      const { data, resultForAssistant } = lastChunk

      if (mode === 'background') {
        const content = resultForAssistant || 'Background task started.'
        return [
          userMessage,
          createAssistantMessage(
            `<background-task-output>${content}</background-task-output>`,
          ),
        ]
      }

      return [
        userMessage,
        createAssistantMessage(
          `<bash-stdout>${data.stdout}</bash-stdout><bash-stderr>${data.stderr}</bash-stderr>`,
        ),
      ]
    } catch (e) {
      return [
        userMessage,
        createAssistantMessage(
          `<bash-stderr>Command failed: ${e instanceof Error ? e.message : String(e)}</bash-stderr>`,
        ),
      ]
    } finally {
      setToolJSX(null)
    }
  }
  // Koding mode - special wrapper for display
  else if (mode === 'koding') {
    const userMessage = createUserMessage(
      `<koding-input>${input}</koding-input>`,
    )
    // Add the Koding flag to the message
    userMessage.options = {
      ...userMessage.options,
      isKodingRequest: true,
    }

    // Rest of koding processing is handled separately to capture assistant response
    return [userMessage]
  }

  // Slash commands
  if (
    context.options?.disableSlashCommands !== true &&
    inputTrimmedStart.startsWith('/')
  ) {
    const words = inputTrimmedStart.slice(1).split(' ')
    let commandName = words[0]
    if (words.length > 1 && words[1] === '(MCP)') {
      commandName = commandName + ' (MCP)'
    }
    if (!commandName) {
      return [
        createAssistantMessage('Commands are in the form `/command [args]`'),
      ]
    }

    // Check if it's a real command before processing
    if (!hasCommand(commandName, context.options?.commands ?? [])) {
      // If not a real command, treat it as a regular user input

      return [createUserMessage(input)]
    }

    // Slash commands can carry per-command `allowedTools` constraints. These must be
    // merged into the same permission engine as persisted rules, and inherited by
    // any forked sub-agent context spawned by the command.
    try {
      const cmd = getCommand(commandName, context.options?.commands ?? [])
      const allowedTools = Array.isArray(cmd.allowedTools)
        ? cmd.allowedTools
        : []
      if (allowedTools.length > 0) {
        const prev = Array.isArray(context.options?.commandAllowedTools)
          ? context.options.commandAllowedTools
          : []
        context.options = {
          ...(context.options ?? {}),
          commandAllowedTools: [...new Set([...prev, ...allowedTools])],
        }
      }
    } catch (error) {
      logError(error)
    }

    const args = inputTrimmedStart.slice(commandName.length + 2)
    const newMessages = await getMessagesForSlashCommand(
      commandName,
      args,
      setToolJSX,
      context,
    )

    // Local JSX commands
    if (newMessages.length === 0) {
      return []
    }

    // For invalid commands, preserve both the user message and error
    if (
      newMessages.length === 2 &&
      newMessages[0]!.type === 'user' &&
      newMessages[1]!.type === 'assistant'
    ) {
      const maybeContent = newMessages[1]!.message.content
      if (extractAssistantText(maybeContent).startsWith('Unknown command:')) {
        return newMessages
      }
    }

    // User-Assistant pair (eg. local commands)
    if (newMessages.length === 2) {
      return newMessages
    }

    // A valid command

    return newMessages
  }

  // Regular user prompt

  // Check if this is a Koding request that needs special handling
  const isKodingRequest = context.options?.isKodingRequest === true
  const kodingContextInfo = context.options?.kodingContext

  // Create base message
  let userMessage: UserMessage

  let processedInput =
    isKodingRequest && kodingContextInfo
      ? `${kodingContextInfo}\n\n${input}`
      : input

  // Process dynamic content for custom commands with ! and @ prefixes
  // This uses the same processing functions as custom commands to maintain consistency
  if (processedInput.includes('!`') || processedInput.includes('@')) {
    try {
      // Import functions from customCommands service to avoid code duplication
      const { executeBashCommands } =
        await import('#cli-services/customCommands')

      // Execute bash commands if present
      if (processedInput.includes('!`')) {
        processedInput = await executeBashCommands(processedInput)
      }

      // Process mentions for system reminder integration
      // Note: We don't call resolveFileReferences here anymore -
      // @file mentions should trigger Read tool usage via reminders, not embed content
      if (processedInput.includes('@')) {
        const { processMentions } =
          await import('#cli-services/mentionProcessor')
        await processMentions(processedInput)
      }
    } catch (error) {
      logError(error)
      // Continue with original input if processing fails
    }
  }

  if (pastedImages && pastedImages.length > 0) {
    const occurrences = pastedImages
      .map(img => ({ img, index: processedInput.indexOf(img.placeholder) }))
      .filter(o => o.index >= 0)
      .sort((a, b) => a.index - b.index)

    const blocks: ContentBlockParam[] = []
    let cursor = 0

    for (const { img, index } of occurrences) {
      const before = processedInput.slice(cursor, index)
      if (before) {
        blocks.push({ type: 'text', text: before })
      }
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: coerceImageMediaType(img.mediaType),
          data: img.data,
        },
      })
      cursor = index + img.placeholder.length
    }

    const after = processedInput.slice(cursor)
    if (after) {
      blocks.push({ type: 'text', text: after })
    }

    if (!blocks.some(b => b.type === 'text')) {
      blocks.push({ type: 'text', text: '' })
    }

    userMessage = createUserMessage(blocks)
  } else {
    userMessage = createUserMessage(processedInput)
  }

  // Add the Koding flag to the message if needed
  if (isKodingRequest) {
    userMessage.options = {
      ...userMessage.options,
      isKodingRequest: true,
    }
  }

  return [userMessage]
}
