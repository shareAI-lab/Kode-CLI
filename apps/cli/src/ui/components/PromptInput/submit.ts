import type React from 'react'
import type { Command } from '#cli-commands'
import type { Message } from '#core/query'
import type { PermissionMode } from '#core/types/PermissionMode'
import type { ToolPermissionContext } from '#core/types/toolPermissionContext'
import type { SetToolJSXFn, Tool } from '#core/tooling/Tool'
import { addToHistory } from '#core/history'
import { logError } from '#core/utils/log'
import {
  handleHashCommand,
  HASH_COMMAND_SAVE_FAILURE_MESSAGE,
} from '#core/utils/hashCommand'
import { processUserInput } from '#ui-ink/utils/processUserInput'
import type { PromptMode } from './types'
import type { PastedImageAttachment, PastedTextSegment } from './pastes'
import {
  expandPastedTextPlaceholders,
  releasePastedImageAttachments,
  resolvePastedImageAttachments,
} from './pastes'
import { interpretHashCommand } from './hashCommand'
import { getCwd } from '#core/utils/state'
import type { SetForkConvoWithMessagesOnTheNextRender } from '#ui-ink/types/conversationReset'
import {
  isShellPromptMode,
  shouldPromptModeReturnToPrompt,
} from './promptModeSpecs'

const EXIT_COMMANDS = new Set(['exit', 'quit', ':q', ':q!', ':wq', ':wq!'])

function extractPasteId(placeholder: string): number | null {
  const match = placeholder.match(
    /\[(Pasted text|Image|\.\.\.Truncated text) #(\d+)(?: \+\d+ lines)?(\.)*\]/,
  )
  if (!match?.[2]) return null
  if (match[1] !== 'Pasted text') return null
  const id = Number(match[2])
  if (!Number.isFinite(id) || id <= 0) return null
  return id
}

function buildHistoryPastedContents(
  pastedTexts: PastedTextSegment[],
): Record<number, { id: number; type: 'text'; content: string }> {
  const out: Record<number, { id: number; type: 'text'; content: string }> = {}
  for (const pasted of pastedTexts) {
    const id = extractPasteId(pasted.placeholder)
    if (!id) continue
    out[id] = { id, type: 'text', content: pasted.text }
  }
  return out
}

function addPromptToHistory(args: {
  display: string
  pastedTexts: PastedTextSegment[]
}): void {
  const pastedContents = buildHistoryPastedContents(args.pastedTexts)
  if (Object.keys(pastedContents).length > 0) {
    addToHistory({ display: args.display, pastedContents })
    return
  }
  addToHistory(args.display)
}

export function getPromptPreparationFailureMessage(
  hasImageAttachments: boolean,
): string {
  if (hasImageAttachments) {
    return 'Unable to prepare the prompt. The text was saved to history; press Up Arrow to restore it and retry. Reattach any images before retrying.'
  }

  return 'Unable to prepare the prompt. Your prompt was saved to history; press Up Arrow to restore it and retry.'
}

export function recoverPromptPreparationFailure(args: {
  savePromptToHistory: () => void
  resetHistory: () => void
  setAbortController: (abortController: AbortController | null) => void
  setIsLoading: (isLoading: boolean) => void
  hasImageAttachments: boolean
  onProcessingError?: (message: string) => void
}): void {
  args.savePromptToHistory()
  args.resetHistory()
  args.setAbortController(null)
  args.setIsLoading(false)
  args.onProcessingError?.(
    getPromptPreparationFailureMessage(args.hasImageAttachments),
  )
}

function getKodingContext(): string {
  return [
    'The user is using Koding mode.',
    'Format your response as a comprehensive, well-structured document suitable for adding to AGENTS.md.',
    'Use proper markdown formatting with headings, lists, code blocks, etc.',
    'The response should be complete and ready to add to AGENTS.md documentation.',
  ].join(' ')
}

export async function submitPrompt(args: {
  input: string
  mode: PromptMode
  isDisabled: boolean
  isLoading: boolean
  isEditingExternally: boolean
  abortController: AbortController | null
  setIsLoading: (isLoading: boolean) => void
  setAbortController: (abortController: AbortController | null) => void
  onInputChange: (value: string) => void
  onModeChange: (mode: PromptMode) => void
  setCursorOffset: (offset: number) => void
  onSubmitCountChange: (updater: (prev: number) => number) => void
  onQuery: (
    newMessages: Message[],
    abortController?: AbortController,
  ) => Promise<void>
  setToolJSX: SetToolJSXFn<React.ReactNode>
  commands: Command[]
  forkNumber: number
  messageLogName: string
  tools: Tool[]
  verbose: boolean
  disableSlashCommands?: boolean
  permissionMode: PermissionMode
  toolPermissionContext: ToolPermissionContext
  setForkConvoWithMessagesOnTheNextRender: SetForkConvoWithMessagesOnTheNextRender
  onShowMessageSelector?: () => void
  readFileTimestamps: { [filename: string]: number }
  pastedTexts: PastedTextSegment[]
  pastedImages: PastedImageAttachment[]
  clearPastes: () => void
  resetHistory: () => void
  onProcessingError?: (message: string) => void
  setCurrentPwd: (pwd: string) => void
  exit: () => void
}): Promise<void> {
  if (args.isEditingExternally) return

  if (!args.input) return
  if (args.isDisabled) return
  if (args.isLoading) return

  const trimmed = args.input.trim()
  if (!trimmed) return

  if (EXIT_COMMANDS.has(trimmed)) {
    args.exit()
    return
  }

  const isKoding = args.mode === 'koding'
  const isKodingActionPrompt =
    isKoding &&
    args.input.match(/^(#\s*)?(put|create|generate|write|give|provide)/i)

  if (isKoding && !isKodingActionPrompt) {
    let noteSaved = false
    try {
      const contentToInterpret = args.input.trim()
      const interpreted = await interpretHashCommand(contentToInterpret)
      noteSaved = handleHashCommand(interpreted)
    } catch (error) {
      logError(error)
    }

    args.onInputChange('')
    args.setCursorOffset(0)
    addPromptToHistory({
      display: args.mode === 'koding' ? `/note ${args.input}` : args.input,
      pastedTexts: args.pastedTexts,
    })
    args.resetHistory()
    args.onModeChange('prompt')
    if (!noteSaved) {
      args.onProcessingError?.(HASH_COMMAND_SAVE_FAILURE_MESSAGE)
    }
    return
  }

  const effectiveMode: PromptMode =
    isKodingActionPrompt && args.mode !== 'bash' ? 'prompt' : args.mode

  const finalInput = expandPastedTextPlaceholders({
    input:
      isKodingActionPrompt && args.mode === 'koding' ? trimmed : args.input,
    pastedTexts: args.pastedTexts,
  })

  const imagesForMessage = resolvePastedImageAttachments(args.pastedImages)

  args.clearPastes()
  args.onInputChange('')
  args.setCursorOffset(0)
  args.onSubmitCountChange(prev => prev + 1)

  if (shouldPromptModeReturnToPrompt(effectiveMode)) {
    args.onModeChange('prompt')
  }

  args.setIsLoading(true)

  const controller = new AbortController()
  args.setAbortController(controller)

  const kodingContext = isKodingActionPrompt ? getKodingContext() : undefined

  let newMessages: Message[]
  try {
    newMessages = await processUserInput(
      finalInput,
      effectiveMode,
      args.setToolJSX,
      {
        options: {
          commands: args.commands,
          forkNumber: args.forkNumber,
          messageLogName: args.messageLogName,
          openMessageSelector: args.onShowMessageSelector,
          tools: args.tools,
          verbose: args.verbose,
          maxThinkingTokens: 0,
          permissionMode: args.permissionMode,
          toolPermissionContext: args.toolPermissionContext,
          disableSlashCommands: args.disableSlashCommands,
          isKodingRequest: isKodingActionPrompt ? true : undefined,
          kodingContext,
        },
        messageId: undefined,
        abortController: controller,
        readFileTimestamps: args.readFileTimestamps,
        setForkConvoWithMessagesOnTheNextRender:
          args.setForkConvoWithMessagesOnTheNextRender,
      },
      imagesForMessage.length > 0 ? imagesForMessage : null,
    )
    releasePastedImageAttachments(args.pastedImages)
  } catch (error) {
    releasePastedImageAttachments(args.pastedImages)
    recoverPromptPreparationFailure({
      savePromptToHistory: () => {
        addPromptToHistory({
          display: args.input,
          pastedTexts: args.pastedTexts,
        })
      },
      resetHistory: args.resetHistory,
      setAbortController: args.setAbortController,
      setIsLoading: args.setIsLoading,
      hasImageAttachments: args.pastedImages.length > 0,
      onProcessingError: args.onProcessingError,
    })
    logError(error)
    return
  }

  if (newMessages.length === 0) {
    addPromptToHistory({ display: args.input, pastedTexts: args.pastedTexts })
    args.resetHistory()
    args.setAbortController(null)
    args.setIsLoading(false)
    return
  }

  const shouldUpdatePwdAfterBash = isShellPromptMode(effectiveMode)

  // Save prompt to history immediately after we successfully construct the user messages.
  // This ensures history is preserved even if the query is aborted (e.g. Escape) or errors mid-flight.
  const inputToAdd =
    effectiveMode === 'bash'
      ? args.input
      : effectiveMode === 'background'
        ? `&${args.input}`
        : args.input

  if (newMessages.some(message => message.type === 'user')) {
    addPromptToHistory({ display: inputToAdd, pastedTexts: args.pastedTexts })
    args.resetHistory()
  }

  try {
    await args.onQuery(newMessages, controller)
    if (shouldUpdatePwdAfterBash) {
      args.setCurrentPwd(getCwd())
    }
  } catch (error) {
    logError(error)
  }
}
