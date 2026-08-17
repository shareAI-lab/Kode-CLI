// Permission modes deliberately have one clear purpose each:
// - acceptEdits (Edit): run tool operations without per-tool prompts
// - plan (Plan): allow only read-only operations
// - cautious (Ask): request approval before operations
export type PermissionMode = 'acceptEdits' | 'plan' | 'cautious'

export type LegacyPermissionMode =
  'yolo' | 'default' | 'bypassPermissions' | 'dontAsk' | 'delegate'

export function isSupportedPermissionModeInput(
  value: unknown,
): value is PermissionMode | LegacyPermissionMode | 'edit' | 'ask' {
  return (
    typeof value === 'string' &&
    [
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
  )
}

/**
 * Converts persisted and command-line values from older releases into the
 * three supported modes. Unknown values deliberately become Ask.
 */
export function normalizePermissionMode(
  mode: PermissionMode | LegacyPermissionMode | string | null | undefined,
): PermissionMode {
  switch (mode) {
    case 'edit':
    case 'acceptEdits':
    case 'yolo':
    case 'bypassPermissions':
      return 'acceptEdits'
    case 'plan':
      return 'plan'
    case 'ask':
    case 'cautious':
    case 'default':
    case 'dontAsk':
    case 'delegate':
    default:
      return 'cautious'
  }
}

export interface PermissionContext {
  mode: PermissionMode
  allowedTools: string[]
  allowedPaths: string[]
  restrictions: {
    readOnly: boolean
    requireConfirmation: boolean
    bypassValidation: boolean
  }
  metadata: {
    activatedAt?: string
    previousMode?: PermissionMode
    transitionCount: number
  }
}

export interface ModeConfig {
  name: PermissionMode
  label: string
  icon: string
  color: string
  description: string
  allowedTools: string[]
  restrictions: {
    readOnly: boolean
    requireConfirmation: boolean
    bypassValidation: boolean
  }
}

// Built-in read-oriented tools presented by the Plan-mode UI. Execution is
// determined by each tool's isReadOnly(input) result, so a newly registered
// read-only tool is not rejected merely because its name is absent here.
export const PLAN_MODE_TOOL_CATALOG = [
  'Read',
  'LS',
  'Grep',
  'Glob',
  'LSP',
  'Bash',
  'WebSearch',
  'WebFetch',
  'AskUserQuestion',
  'AskExpertModel',
  'TaskList',
  'TaskGet',
  'TaskOutput',
  'TaskMonitor',
  'TaskBatch',
  'EnterPlanMode',
  'ExitPlanMode',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'MCPSearch',
] as const

// Mode configuration
export const MODE_CONFIGS: Record<PermissionMode, ModeConfig> = {
  cautious: {
    name: 'cautious',
    label: 'Ask',
    icon: '??',
    color: 'blue',
    description: 'Requires confirmation for all tool uses',
    allowedTools: ['*'],
    restrictions: {
      readOnly: false,
      requireConfirmation: true,
      bypassValidation: false,
    },
  },
  acceptEdits: {
    name: 'acceptEdits',
    label: 'Edit',
    icon: '>>',
    color: 'green',
    description:
      'Auto-run tools and edits; hard deny rules and protected paths still apply',
    allowedTools: ['*'],
    restrictions: {
      readOnly: false,
      requireConfirmation: false,
      bypassValidation: false,
    },
  },
  plan: {
    name: 'plan',
    label: 'Plan',
    icon: '||',
    color: 'yellow',
    description: 'Research and planning - read-only tools only',
    allowedTools: [...PLAN_MODE_TOOL_CATALOG],
    restrictions: {
      readOnly: true,
      requireConfirmation: true,
      bypassValidation: false,
    },
  },
}

// Mode cycling function: Edit -> Plan -> Ask -> Edit.
export function getNextPermissionMode(
  currentMode: PermissionMode,
): PermissionMode {
  switch (currentMode) {
    case 'acceptEdits':
      return 'plan'
    case 'plan':
      return 'cautious'
    case 'cautious':
      return 'acceptEdits'
  }
}
