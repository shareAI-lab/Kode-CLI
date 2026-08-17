import type { MessageParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { ReactNode } from 'react'

import type { Message } from '#core/query'
import type { Tool, ToolUseContext } from '#core/tooling/Tool'
import type { SetForkConvoWithMessagesOnTheNextRender } from '#ui-ink/types/conversationReset'

export type PromptCommand = {
  type: 'prompt'
  progressMessage: string
  /** Short status shown while the command is waiting for the first model response. */
  requestStatusDetail?: string
  argNames?: string[]
  getPromptForCommand(args: string): Promise<MessageParam[]>
}

export type LocalCommand = {
  type: 'local'
  call(
    args: string,
    context: {
      options: {
        commands: Command[]
        tools: Tool[]
        slowAndCapableModel: string
        openMessageSelector?: () => void
      }
      abortController: AbortController
      setForkConvoWithMessagesOnTheNextRender: SetForkConvoWithMessagesOnTheNextRender
    },
  ): Promise<string>
}

export type LocalJSXCommand = {
  type: 'local-jsx'
  call(
    onDone: LocalJSXDoneCallback,
    context: ToolUseContext & {
      setForkConvoWithMessagesOnTheNextRender: SetForkConvoWithMessagesOnTheNextRender
    },
    args?: string,
  ): Promise<ReactNode>
}

/** A local JSX command can either render output or submit a normal REPL prompt. */
export type LocalJSXCommandResult =
  | string
  | {
      type: 'submit-prompt'
      prompt: string
      /** Marks the input as reviewed speech for turn-level clarification policy. */
      voiceInput?: boolean
      /** Request best-effort TTS after the corresponding assistant turn. */
      voiceResponse?: boolean
    }
  | {
      /** Route an aggregate command to an existing slash command without adding an extra transcript entry. */
      type: 'delegate-command'
      commandName: string
      args: string
    }

// The callback is intentionally bivariant for backwards-compatible commands
// whose completion handler only accepts text. New interactive commands can
// submit a prompt object without forcing every existing command to change.
export type LocalJSXDoneCallback = {
  bivarianceHack(result?: LocalJSXCommandResult): void
}['bivarianceHack']

export type Command = {
  description: string
  isEnabled: boolean
  isHidden: boolean
  name: string
  ui?: {
    displayMode?: 'inline' | 'fullscreen'
  }
  /**
   * Optional hint text for command arguments shown in help/menus.
   * Example: "[style]" or "<tag-name>".
   */
  argumentHint?: string
  aliases?: string[]
  /**
   * If true, this command must not be invoked via non-interactive tool calls
   * (e.g. SlashCommandTool / SkillTool).
   */
  disableNonInteractive?: boolean
  /**
   * Optional pre-approved tools for command execution (compatibility).
   */
  allowedTools?: string[]
  userFacingName(): string
} & (PromptCommand | LocalCommand | LocalJSXCommand)
