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

export function buildPromptInputStatusLine(args: {
  mode: PromptMode
  permissionMode: PermissionMode
  modeCycleShortcutText: string
  isLoading: boolean
  pendingPromptCount: number
  queuedPromptCount: number
  editorMode?: string
  vimMode?: 'INSERT' | 'NORMAL'
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
    parts.push('Alt+Up edit')
  }

  return parts.join(' \u00b7 ')
}
