import * as React from 'react'
import type { Message } from '#core/query'
import { getCommand } from '#cli-commands'
import { MalformedCommandError } from '#core/utils/errors'
import { logError } from '#core/utils/log'
import type { SetToolJSXFn, ToolUseContext } from '#core/tooling/Tool'
import {
  createAssistantMessage,
  createUserMessage,
  NO_RESPONSE_REQUESTED,
} from '#core/utils/messages'
import type { SetForkConvoWithMessagesOnTheNextRender } from '#ui-ink/types/conversationReset'
import type { LocalJSXCommandResult } from '#cli-commands/types'

function isCommandDelegationResult(
  result: LocalJSXCommandResult | undefined,
): result is Extract<LocalJSXCommandResult, { type: 'delegate-command' }> {
  return typeof result !== 'string' && result?.type === 'delegate-command'
}

/** Convert an interactive local JSX result into the ordinary REPL input type. */
export function createInteractivePromptMessage(
  result: LocalJSXCommandResult,
): Message | null {
  if (typeof result === 'string' || result.type !== 'submit-prompt') return null
  const prompt = result.prompt.trim()
  if (!prompt) return null

  const userMessage = createUserMessage(prompt)
  userMessage.options = {
    ...userMessage.options,
    voiceInput: result.voiceInput === true,
    voiceResponse: result.voiceResponse === true,
  }
  return userMessage
}

export async function getMessagesForSlashCommand(
  commandName: string,
  args: string,
  setToolJSX: SetToolJSXFn<React.ReactNode>,
  context: ToolUseContext & {
    setForkConvoWithMessagesOnTheNextRender: SetForkConvoWithMessagesOnTheNextRender
  },
): Promise<Message[]> {
  try {
    const command = getCommand(commandName, context.options?.commands ?? [])

    switch (command.type) {
      case 'local-jsx': {
        return new Promise(resolveMessages => {
          let didMountJsx = false
          command
            .call(
              r => {
                setToolJSX(null)

                // Interactive local JSX commands (fullscreen overlays, selectors, etc.)
                // should not pollute the transcript with command meta messages unless
                // they explicitly return output.
                if (didMountJsx) {
                  if (!r || r === NO_RESPONSE_REQUESTED) {
                    resolveMessages([])
                    return
                  }
                  if (isCommandDelegationResult(r)) {
                    void getMessagesForSlashCommand(
                      r.commandName,
                      r.args,
                      setToolJSX,
                      context,
                    )
                      .then(resolveMessages)
                      .catch(error => {
                        logError(error)
                        resolveMessages([
                          createAssistantMessage(
                            `Command delegation failed: ${
                              error instanceof Error
                                ? error.message
                                : String(error)
                            }`,
                          ),
                        ])
                      })
                    return
                  }
                  if (typeof r !== 'string' && r.type === 'submit-prompt') {
                    const userMessage = createInteractivePromptMessage(r)
                    if (!userMessage) {
                      resolveMessages([])
                      return
                    }
                    resolveMessages([userMessage])
                    return
                  }
                  resolveMessages([
                    createAssistantMessage(
                      typeof r === 'string'
                        ? r
                        : 'Interactive command returned an unsupported result.',
                    ),
                  ])
                  return
                }

                resolveMessages([
                  createUserMessage(`<command-name>${command.userFacingName()}</command-name>
          <command-message>${command.userFacingName()}</command-message>
          <command-args>${args}</command-args>`),
                  r
                    ? createAssistantMessage(
                        typeof r === 'string'
                          ? r
                          : 'Interactive command returned an unsupported result.',
                      )
                    : createAssistantMessage(NO_RESPONSE_REQUESTED),
                ])
              },
              context,
              args,
            )
            .then(jsx => {
              if (!jsx) return
              didMountJsx = true
              setToolJSX({
                jsx,
                shouldHidePromptInput: true,
                displayMode: command.ui?.displayMode ?? 'inline',
              })
            })
        })
      }

      case 'local': {
        const userMessage =
          createUserMessage(`<command-name>${command.userFacingName()}</command-name>
        <command-message>${command.userFacingName()}</command-message>
        <command-args>${args}</command-args>`)

        try {
          const baseOptions = context.options ?? {}
          // Use the context's abortController for local commands
          const result = await command.call(args, {
            ...context,
            options: {
              ...baseOptions,
              commands: baseOptions.commands ?? [],
              tools: baseOptions.tools ?? [],
              slowAndCapableModel: baseOptions.slowAndCapableModel ?? 'main',
            },
          })

          return [
            userMessage,
            createAssistantMessage(
              `<local-command-stdout>${result}</local-command-stdout>`,
            ),
          ]
        } catch (e) {
          logError(e)
          return [
            userMessage,
            createAssistantMessage(
              `<local-command-stderr>${String(e)}</local-command-stderr>`,
            ),
          ]
        }
      }

      case 'prompt': {
        // Compatibility: emit a metadata message, then the expanded prompt.
        const commandName = command.userFacingName()
        const progressMessage = command.progressMessage || 'running'
        const metaMessage =
          createUserMessage(`<command-name>${commandName}</command-name>
        <command-message>${commandName} is ${progressMessage}…</command-message>
        <command-args>${args}</command-args>`)

        const prompt = await command.getPromptForCommand(args)
        const expandedMessages = prompt.map(msg => {
          // Create a normal user message from the custom command content
          const userMessage = createUserMessage(
            typeof msg.content === 'string'
              ? msg.content
              : msg.content
                  .map(block => (block.type === 'text' ? block.text : ''))
                  .join('\n'),
          )

          // Add metadata for tracking but don't wrap in special tags
          userMessage.options = {
            ...userMessage.options,
            isCustomCommand: true,
            commandName: command.userFacingName(),
            commandArgs: args,
            requestStatusDetail: command.requestStatusDetail,
          }

          return userMessage
        })

        return [metaMessage, ...expandedMessages]
      }
    }
  } catch (e) {
    if (e instanceof MalformedCommandError) {
      return [createAssistantMessage(e.message)]
    }
    throw e
  }
}
