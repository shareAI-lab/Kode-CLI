import {
  normalizePermissionMode,
  type PermissionMode,
} from '#core/types/PermissionMode'
import type {
  ToolPermissionContext,
  ToolPermissionContextUpdate,
} from '#core/types/toolPermissionContext'
import { applyToolPermissionContextUpdates } from '#core/types/toolPermissionContext'

export class InvalidHeadlessPermissionModeError extends Error {
  constructor(readonly permissionMode: string) {
    super(
      `Invalid --permission-mode "${permissionMode}". Expected one of: edit, plan, ask`,
    )
    this.name = 'InvalidHeadlessPermissionModeError'
  }
}

function cliRuleList(value: unknown): string[] {
  if (!value) return []
  const raw = Array.isArray(value) ? value : [value]
  return raw
    .flatMap(item => String(item ?? '').split(','))
    .map(item => item.trim())
    .filter(Boolean)
}

function parsePermissionMode(value: string): PermissionMode | null {
  if (
    ![
      'acceptEdits',
      'cautious',
      'plan',
      'yolo',
      'default',
      'bypassPermissions',
      'dontAsk',
      'delegate',
      'edit',
      'ask',
    ].includes(value)
  ) {
    return null
  }
  if (value === 'edit') return 'acceptEdits'
  if (value === 'ask') return 'cautious'
  return normalizePermissionMode(value)
}

export function buildHeadlessToolPermissionContext(args: {
  baseContext: ToolPermissionContext
  safe?: boolean
  allowedTools?: unknown
  disallowedTools?: unknown
  addDir?: unknown
  permissionMode?: string
  dangerouslySkipPermissions?: boolean
  inputFormat: string
  hasPermissionPromptTool: boolean
}): ToolPermissionContext {
  const updates: ToolPermissionContextUpdate[] = []
  const allowedRules = cliRuleList(args.allowedTools)
  const deniedRules = cliRuleList(args.disallowedTools)
  const additionalDirs = cliRuleList(args.addDir)

  if (allowedRules.length > 0) {
    updates.push({
      type: 'addRules',
      destination: 'cliArg',
      behavior: 'allow',
      rules: allowedRules,
    })
  }
  if (deniedRules.length > 0) {
    updates.push({
      type: 'addRules',
      destination: 'cliArg',
      behavior: 'deny',
      rules: deniedRules,
    })
  }
  if (additionalDirs.length > 0) {
    updates.push({
      type: 'addDirectories',
      destination: 'cliArg',
      directories: additionalDirs,
    })
  }

  const normalizedPermissionMode =
    typeof args.permissionMode === 'string' ? args.permissionMode.trim() : ''
  if (normalizedPermissionMode) {
    const normalized = parsePermissionMode(normalizedPermissionMode)
    if (!normalized) {
      throw new InvalidHeadlessPermissionModeError(normalizedPermissionMode)
    }
    updates.push({
      type: 'setMode',
      destination: 'cliArg',
      mode: normalized,
    })
  }

  if (args.dangerouslySkipPermissions) {
    updates.push({
      type: 'setMode',
      destination: 'cliArg',
      mode: 'acceptEdits',
    })
  }

  return applyToolPermissionContextUpdates(args.baseContext, updates)
}
