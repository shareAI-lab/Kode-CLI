// Permission mode types
// - yolo: Auto-execute non-destructive commands, prompt only for HIGH severity
// - cautious: Requires confirmation for all tool uses (original default behavior)
// - acceptEdits: Auto-approve edit operations
// - plan: Research and planning - read-only tools only
// - bypassPermissions: All permissions bypassed
// - dontAsk: Auto-deny permission prompts
export type PermissionMode =
  | 'yolo'
  | 'cautious'
  | 'default' // Legacy alias for cautious
  | 'acceptEdits'
  | 'plan'
  | 'bypassPermissions'
  | 'dontAsk'

// Normalize legacy 'default' to 'cautious'
export function normalizePermissionMode(mode: PermissionMode): PermissionMode {
  return mode === 'default' ? 'cautious' : mode
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
  yolo: {
    name: 'yolo',
    label: 'YOLO',
    icon: '',
    color: 'text',
    description: 'Auto-execute non-destructive, prompt for HIGH severity only',
    allowedTools: ['*'],
    restrictions: {
      readOnly: false,
      requireConfirmation: false,
      bypassValidation: false,
    },
  },
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
  default: {
    name: 'default',
    label: 'Ask',
    icon: '??',
    color: 'blue',
    description: 'Legacy alias for cautious',
    allowedTools: ['*'],
    restrictions: {
      readOnly: false,
      requireConfirmation: true,
      bypassValidation: false,
    },
  },
  acceptEdits: {
    name: 'acceptEdits',
    label: 'Accept Edits',
    icon: '>>',
    color: 'green',
    description: 'Auto-approve edit operations',
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
  bypassPermissions: {
    name: 'bypassPermissions',
    label: 'Bypass',
    icon: '🚀',
    color: 'red',
    description: 'All permissions bypassed',
    allowedTools: ['*'],
    restrictions: {
      readOnly: false,
      requireConfirmation: false,
      bypassValidation: true,
    },
  },
  dontAsk: {
    name: 'dontAsk',
    label: "Don't Ask",
    icon: 'X',
    color: 'red',
    description: 'Auto-deny permission prompts',
    allowedTools: ['*'],
    restrictions: {
      readOnly: false,
      requireConfirmation: true,
      bypassValidation: false,
    },
  },
}

// Mode cycling function: yolo -> plan -> acceptEdits -> cautious -> [bypassPermissions] -> yolo
export function getNextPermissionMode(
  currentMode: PermissionMode,
  isBypassAvailable: boolean = true,
): PermissionMode {
  const normalized = normalizePermissionMode(currentMode)
  switch (normalized) {
    case 'yolo':
      return 'plan'
    case 'plan':
      return 'acceptEdits'
    case 'acceptEdits':
      return 'cautious'
    case 'cautious':
      return isBypassAvailable ? 'bypassPermissions' : 'yolo'
    case 'bypassPermissions':
      return 'yolo'
    case 'dontAsk':
      return 'yolo'
    default:
      return 'yolo'
  }
}
