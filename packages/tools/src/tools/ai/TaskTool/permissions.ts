import type { PermissionMode } from '#core/types/PermissionMode'
import type { ToolPermissionContext } from '#core/types/toolPermissionContext'
import type { AgentPermissionMode } from '@kode/agent'

export function normalizeAgentPermissionMode(
  mode: AgentPermissionMode | undefined,
): PermissionMode | undefined {
  if (!mode) return undefined
  switch (mode) {
    case 'acceptEdits':
    case 'plan':
    case 'cautious':
      return mode
    case 'default':
    case 'delegate':
    case 'dontAsk':
      return 'cautious'
    case 'yolo':
    case 'bypassPermissions':
      return 'acceptEdits'
  }
}

export function applyAgentPermissionMode(
  base: ToolPermissionContext | undefined,
  options: {
    agentPermissionMode: PermissionMode | undefined
    safeMode: boolean
  },
): ToolPermissionContext | undefined {
  if (!base) return base
  if (!options.agentPermissionMode) return base

  const rank = (mode: PermissionMode): number => {
    switch (mode) {
      case 'plan':
        return 0
      case 'cautious':
        return 1
      case 'acceptEdits':
        return 2
    }
  }

  let nextMode: PermissionMode = options.agentPermissionMode

  // Subagents must not auto-escalate permission mode beyond the parent context.
  // They may narrow permissions (e.g. Ask -> Plan), but must not loosen them
  // (e.g. Plan -> Edit) without an explicit user flow.
  if (rank(nextMode) > rank(base.mode)) return base

  if (nextMode === base.mode) return base
  return { ...base, mode: nextMode }
}
