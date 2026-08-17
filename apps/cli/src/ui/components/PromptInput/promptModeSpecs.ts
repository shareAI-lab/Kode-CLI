import type { Theme } from '#core/utils/theme'
import type { PromptMode } from './types'

type PromptModeBorderColorKey = 'inputBorder' | 'bashBorder' | 'notingBorder'

export type PromptModeSpec = {
  mode: PromptMode
  label: string
  prefix: string
  statusText: string
  helperText: string
  borderColorKey: PromptModeBorderColorKey
  shellLike: boolean
  returnToPromptAfterSubmit: boolean
  emptyInputExitKeysReturnToPrompt: boolean
  typedPrefix?: string
}

export const PROMPT_MODE_SPECS: Record<PromptMode, PromptModeSpec> = {
  prompt: {
    mode: 'prompt',
    label: 'Chat',
    prefix: '',
    statusText: 'Chat',
    helperText: '',
    borderColorKey: 'inputBorder',
    shellLike: false,
    returnToPromptAfterSubmit: true,
    emptyInputExitKeysReturnToPrompt: false,
  },
  bash: {
    mode: 'bash',
    label: 'Shell',
    prefix: '',
    statusText: 'Shell',
    helperText: 'Esc chat',
    borderColorKey: 'bashBorder',
    shellLike: true,
    returnToPromptAfterSubmit: false,
    emptyInputExitKeysReturnToPrompt: true,
  },
  background: {
    mode: 'background',
    label: 'Background shell',
    prefix: '&',
    statusText: 'Shell (bg)',
    helperText: 'Esc chat',
    borderColorKey: 'bashBorder',
    shellLike: true,
    returnToPromptAfterSubmit: false,
    emptyInputExitKeysReturnToPrompt: true,
    typedPrefix: '&',
  },
  koding: {
    mode: 'koding',
    label: 'Legacy note',
    prefix: '#',
    statusText: 'Note',
    helperText: 'Esc chat',
    borderColorKey: 'notingBorder',
    shellLike: false,
    returnToPromptAfterSubmit: true,
    emptyInputExitKeysReturnToPrompt: true,
  },
}

export function getPromptModeSpec(mode: PromptMode): PromptModeSpec {
  return PROMPT_MODE_SPECS[mode] ?? PROMPT_MODE_SPECS.prompt
}

export function getPromptModeForTypedPrefix(args: {
  mode: PromptMode
  value: string
}): PromptMode | null {
  if (args.mode !== 'prompt') return null

  const background = PROMPT_MODE_SPECS.background
  if (background.typedPrefix && args.value.startsWith(background.typedPrefix)) {
    return background.mode
  }

  return null
}

export function applyTypedPromptModePrefix(args: {
  mode: PromptMode
  value: string
}): { mode: PromptMode; value: string } | null {
  const nextMode = getPromptModeForTypedPrefix(args)
  if (!nextMode) return null

  const prefix = getPromptModeSpec(nextMode).typedPrefix ?? ''
  const remainder =
    prefix && args.value.startsWith(prefix)
      ? args.value.slice(prefix.length)
      : args.value

  return { mode: nextMode, value: remainder }
}

export function getPromptModePrefix(args: {
  mode: PromptMode
  theme: Theme
  isLoading: boolean
}): { text: string; color?: string } {
  const spec = getPromptModeSpec(args.mode)

  switch (spec.mode) {
    case 'background':
      return { text: '&\u00a0', color: args.theme.bashBorder }
    case 'koding':
      return { text: '#\u00a0', color: args.theme.noting }
    case 'bash':
      return { text: '\u276F\u00a0', color: args.theme.bashBorder }
    case 'prompt':
    default:
      return {
        text: '\u276F\u00a0',
        color: args.isLoading ? args.theme.secondaryText : undefined,
      }
  }
}

export function getPromptModeBorderColor(
  mode: PromptMode,
  theme: Theme,
): string {
  return theme[getPromptModeSpec(mode).borderColorKey]
}

export function isShellPromptMode(mode: PromptMode): boolean {
  return getPromptModeSpec(mode).shellLike
}

export function shouldPromptModeReturnToPrompt(mode: PromptMode): boolean {
  return getPromptModeSpec(mode).returnToPromptAfterSubmit
}

export function shouldEmptyPromptModeExitToPrompt(mode: PromptMode): boolean {
  return getPromptModeSpec(mode).emptyInputExitKeysReturnToPrompt
}
