import type { PermissionMode } from './PermissionMode'

// Compatibility: mirrors the toolPermissionContext shape and update operations used by legacy transcripts.

export type ToolPermissionUpdateDestination =
  | 'session'
  | 'localSettings'
  | 'userSettings'
  | 'projectSettings'
  | 'flagSettings'
  | 'policySettings'
  | 'cliArg'
  | 'command'

export type ToolPermissionRuleBehavior = 'allow' | 'deny' | 'ask'

export type AdditionalWorkingDirectoryEntry = {
  path: string
  source: ToolPermissionUpdateDestination
}

export type ToolPermissionContext = {
  mode: PermissionMode
  additionalWorkingDirectories: Map<string, AdditionalWorkingDirectoryEntry>
  alwaysAllowRules: Partial<Record<ToolPermissionUpdateDestination, string[]>>
  alwaysDenyRules: Partial<Record<ToolPermissionUpdateDestination, string[]>>
  alwaysAskRules: Partial<Record<ToolPermissionUpdateDestination, string[]>>
}

export type ToolPermissionContextUpdate =
  | {
      type: 'setMode'
      mode: PermissionMode
      destination: ToolPermissionUpdateDestination
    }
  | {
      type: 'addRules'
      destination: ToolPermissionUpdateDestination
      behavior: ToolPermissionRuleBehavior
      rules: string[]
    }
  | {
      type: 'replaceRules'
      destination: ToolPermissionUpdateDestination
      behavior: ToolPermissionRuleBehavior
      rules: string[]
    }
  | {
      type: 'removeRules'
      destination: ToolPermissionUpdateDestination
      behavior: ToolPermissionRuleBehavior
      rules: string[]
    }
  | {
      type: 'addDirectories'
      destination: ToolPermissionUpdateDestination
      directories: string[]
    }
  | {
      type: 'removeDirectories'
      destination: ToolPermissionUpdateDestination
      directories: string[]
    }

export function createDefaultToolPermissionContext(options?: {
  /** @deprecated Bypass is no longer a permission mode and this value is ignored. */
  isBypassPermissionsModeAvailable?: boolean
  mode?: PermissionMode
}): ToolPermissionContext {
  return {
    // Match the normal interactive CLI default: work inside the opened
    // workspace proceeds without a per-tool approval. Plan mode and explicit
    // allow/ask/deny rules remain opt-in controls.
    mode: options?.mode ?? 'acceptEdits',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
  }
}

export function applyToolPermissionContextUpdate(
  context: ToolPermissionContext,
  update: ToolPermissionContextUpdate,
): ToolPermissionContext {
  switch (update.type) {
    case 'setMode':
      return { ...context, mode: update.mode }
    case 'addRules': {
      const key =
        update.behavior === 'allow'
          ? 'alwaysAllowRules'
          : update.behavior === 'deny'
            ? 'alwaysDenyRules'
            : 'alwaysAskRules'
      const existing = context[key][update.destination] ?? []
      return {
        ...context,
        [key]: {
          ...context[key],
          [update.destination]: [...existing, ...update.rules],
        },
      }
    }
    case 'replaceRules': {
      const key =
        update.behavior === 'allow'
          ? 'alwaysAllowRules'
          : update.behavior === 'deny'
            ? 'alwaysDenyRules'
            : 'alwaysAskRules'
      return {
        ...context,
        [key]: {
          ...context[key],
          [update.destination]: [...update.rules],
        },
      }
    }
    case 'removeRules': {
      const key =
        update.behavior === 'allow'
          ? 'alwaysAllowRules'
          : update.behavior === 'deny'
            ? 'alwaysDenyRules'
            : 'alwaysAskRules'
      const current = context[key][update.destination] ?? []
      const toRemove = new Set(update.rules)
      const next = current.filter(rule => !toRemove.has(rule))
      return {
        ...context,
        [key]: {
          ...context[key],
          [update.destination]: next,
        },
      }
    }
    case 'addDirectories': {
      const nextDirs = new Map(context.additionalWorkingDirectories)
      for (const dir of update.directories) {
        nextDirs.set(dir, { path: dir, source: update.destination })
      }
      return { ...context, additionalWorkingDirectories: nextDirs }
    }
    case 'removeDirectories': {
      const nextDirs = new Map(context.additionalWorkingDirectories)
      for (const dir of update.directories) {
        nextDirs.delete(dir)
      }
      return { ...context, additionalWorkingDirectories: nextDirs }
    }
    default:
      return context
  }
}

export function applyToolPermissionContextUpdates(
  context: ToolPermissionContext,
  updates: ToolPermissionContextUpdate[],
): ToolPermissionContext {
  let next = context
  for (const update of updates) {
    next = applyToolPermissionContextUpdate(next, update)
  }
  return next
}

export function isPersistableToolPermissionDestination(
  destination: ToolPermissionUpdateDestination,
): destination is 'localSettings' | 'userSettings' | 'projectSettings' {
  return (
    destination === 'localSettings' ||
    destination === 'userSettings' ||
    destination === 'projectSettings'
  )
}

export function canUserModifyToolPermissionUpdate(
  update: ToolPermissionContextUpdate,
): boolean {
  if (update.destination !== 'policySettings') return true
  // Managed policy settings are read-only (at least for deletion/overwrite).
  if (update.type === 'removeRules') return false
  if (update.type === 'replaceRules') return false
  if (update.type === 'removeDirectories') return false
  return true
}
