import type { PermissionMode } from '#core/types/PermissionMode'
import type { PromptMode } from './types'
import { getPermissionModeCompactLabel } from '#ui-ink/utils/permissionModeDisplay'
import { getPromptModeSpec } from './promptModeSpecs'

export type InputModeDisplay = {
  label: string
  prefix: string
  statusText: string
  helperText: string
}

export function getInputModeDisplay(mode: PromptMode): InputModeDisplay {
  const spec = getPromptModeSpec(mode)
  return {
    label: spec.label,
    prefix: spec.prefix,
    statusText: spec.statusText,
    helperText: spec.helperText,
  }
}

export const PROMPT_STASHED_MESSAGE = 'Prompt stashed · Ctrl+S to restore'
export const PROMPT_RESTORED_MESSAGE = 'Prompt restored'
export const PROMPT_NOTHING_TO_STASH_MESSAGE = 'Nothing to stash'

export function formatCancelledFollowUpsMessage(count: number): string {
  if (count <= 0) return 'Cancelled'
  if (count === 1) return 'Cancelled · discarded 1 follow-up'
  return `Cancelled · discarded ${count} follow-ups`
}

export function buildPromptInputStatusLine(args: {
  mode: PromptMode
  permissionMode: PermissionMode
  modeCycleShortcutText: string
  isLoading: boolean
  pendingPromptCount: number
  queuedPromptCount: number
  editorMode?: string
  vimMode?: 'INSERT' | 'NORMAL'
  stashRestorable?: boolean
}): string {
  const inputMode = getInputModeDisplay(args.mode)
  const parts = [
    inputMode.statusText,
    inputMode.helperText,
    `Tools ${getPermissionModeCompactLabel(args.permissionMode)} (${args.modeCycleShortcutText})`,
  ].filter(Boolean)

  if (args.editorMode === 'vim' && args.vimMode === 'INSERT') {
    parts.unshift('-- INSERT --')
  } else if (args.editorMode === 'vim' && args.vimMode === 'NORMAL') {
    parts.unshift('-- NORMAL --')
  }

  if (args.isLoading) {
    parts.push('Tab queue')
  }

  if (args.pendingPromptCount > 0) {
    parts.push(`pending ${args.pendingPromptCount}`)
  }

  if (args.queuedPromptCount > 0) {
    parts.push(`queued ${args.queuedPromptCount}`)
  }

  if (args.pendingPromptCount > 0 || args.queuedPromptCount > 0) {
    parts.push('Alt+Up edit')
  }

  if (args.stashRestorable) {
    parts.push('Ctrl+S restore')
  }

  return parts.join(' \u00b7 ')
}
