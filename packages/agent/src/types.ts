export type AgentSource =
  | 'built-in'
  | 'plugin'
  | 'userSettings'
  | 'projectSettings'
  | 'flagSettings'
  | 'policySettings'

export type AgentLocation = 'built-in' | 'plugin' | 'user' | 'project'

export type AgentModel = 'inherit' | 'haiku' | 'sonnet' | 'opus' | (string & {})

export type AgentPermissionMode =
  | 'acceptEdits'
  | 'cautious'
  | 'plan'
  | 'yolo'
  | 'default'
  | 'bypassPermissions'
  | 'dontAsk'
  | 'delegate'

export interface AgentConfig {
  agentType: string // matches subagent_type
  whenToUse: string
  /**
   * Tools the agent is allowed to use.
   * - "*" means all tools
   * - [] means no tools
   */
  tools: string[] | '*'
  disallowedTools?: string[]
  skills?: string[]
  systemPrompt: string
  source: AgentSource
  location: AgentLocation
  baseDir?: string
  filename?: string
  color?: string
  model?: AgentModel
  permissionMode?: AgentPermissionMode
  forkContext?: boolean
  /** Per-run wall-clock deadline. The runtime still applies its hard cap. */
  maxExecutionTimeMs?: number
}
