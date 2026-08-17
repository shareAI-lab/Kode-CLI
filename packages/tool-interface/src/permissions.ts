export type PermissionMode = 'cautious' | 'acceptEdits' | 'plan'

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
