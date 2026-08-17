import { homedir } from 'node:os'

import type { VoiceConfig } from './voice'

export type ThemeNames =
  // Light themes
  | 'light'
  | 'light-daltonized'
  | 'high-contrast-light'
  | 'solarized-light'
  | 'github-light'
  // Dark themes
  | 'dark'
  | 'dark-daltonized'
  | 'high-contrast-dark'
  | 'dracula'
  | 'nord'
  | 'monokai'
  | 'tokyo-night'
  | 'catppuccin'
  | 'gruvbox'
  | 'one-dark'
  | 'solarized-dark'

export type McpStdioServerConfig = {
  type?: 'stdio'
  command: string
  args: string[]
  env?: Record<string, string>
}

export type McpSSEServerConfig = {
  type: 'sse'
  url: string
  headers?: Record<string, string>
  headersHelper?: string
}

export type McpHttpServerConfig = {
  type: 'http'
  url: string
  headers?: Record<string, string>
  headersHelper?: string
}

export type McpSSEIdeServerConfig = {
  type: 'sse-ide'
  url: string
  ideName: string
  ideRunningInWindows?: boolean
  headers?: Record<string, string>
  headersHelper?: string
}

export type McpWsServerConfig = {
  type: 'ws'
  url: string
}

export type McpWsIdeServerConfig = {
  type: 'ws-ide'
  url: string
  ideName: string
  authToken?: string
  ideRunningInWindows?: boolean
}

export type McpServerConfig =
  | McpStdioServerConfig
  | McpSSEServerConfig
  | McpHttpServerConfig
  | McpSSEIdeServerConfig
  | McpWsServerConfig
  | McpWsIdeServerConfig

export type ProjectConfig = {
  allowedTools: string[]
  deniedTools?: string[]
  askedTools?: string[]
  context: Record<string, string>
  contextFiles?: string[]
  history: string[]
  promptDrafts?: Record<
    string,
    {
      text: string
      mode: 'prompt' | 'bash' | 'background' | 'koding'
      cursorOffset: number
      updatedAt: number
    }
  >
  dontCrawlDirectory?: boolean
  enableArchitectTool?: boolean
  mcpContextUris: string[]
  mcpServers?: Record<string, McpServerConfig>
  disabledMcpServers?: string[]
  approvedMcprcServers?: string[]
  rejectedMcprcServers?: string[]
  lastAPIDuration?: number
  lastCost?: number
  lastDuration?: number
  lastSessionId?: string
  exampleFiles?: string[]
  exampleFilesGeneratedAt?: number
  hasTrustDialogAccepted?: boolean
  hasCompletedProjectOnboarding?: boolean
}

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  allowedTools: [],
  deniedTools: [],
  askedTools: [],
  context: {},
  history: [],
  promptDrafts: {},
  dontCrawlDirectory: false,
  enableArchitectTool: false,
  mcpContextUris: [],
  mcpServers: {},
  disabledMcpServers: [],
  approvedMcprcServers: [],
  rejectedMcprcServers: [],
  hasTrustDialogAccepted: false,
}

export function defaultConfigForProject(projectPath: string): ProjectConfig {
  const config = { ...DEFAULT_PROJECT_CONFIG }
  if (projectPath === homedir()) {
    config.dontCrawlDirectory = true
  }
  return config
}

export type AutoUpdaterStatus =
  'disabled' | 'enabled' | 'no_permissions' | 'not_configured'

export function isAutoUpdaterStatus(value: string): value is AutoUpdaterStatus {
  return ['disabled', 'enabled', 'no_permissions', 'not_configured'].includes(
    value as AutoUpdaterStatus,
  )
}

export type NotificationChannel =
  'iterm2' | 'terminal_bell' | 'iterm2_with_bell' | 'notifications_disabled'

export type ProviderType =
  | 'anthropic'
  | 'openai'
  | 'mistral'
  | 'deepseek'
  | 'kimi'
  | 'qwen'
  | 'glm'
  | 'minimax'
  | 'baidu-qianfan'
  | 'siliconflow'
  | 'bigdream'
  | 'opendev'
  | 'xai'
  | 'groq'
  | 'openrouter'
  | 'gemini'
  | 'ollama'
  | 'azure'
  | 'custom'
  | 'custom-openai'
  /** Uses the locally authenticated official Codex CLI runtime. */
  | 'codex-oauth'
  /** Uses the locally authenticated official GitHub Copilot runtime. */
  | 'github-copilot'
  /** Uses the locally authenticated official Grok Build runtime. */
  | 'grok-build'
  | (string & {})

export type RequestStrategy =
  | 'auto'
  | 'kode'
  | 'compat_headers'
  | 'compat_headers_system'
  | 'compat_full'
  | 'claude_code_headers'
  | 'claude_code_headers_system'
  | 'claude_code_full'

export type ModelProfile = {
  name: string
  provider: ProviderType
  modelName: string
  /**
   * Provider-native model identifier for runtimes whose Kode profile IDs are
   * namespaced to avoid collisions with direct API profiles.
   */
  externalModelId?: string
  /**
   * Opaque reference to an OAuth credential binding in Kode's owner-only
   * credential store. The OAuth token itself remains in the official runtime.
   */
  oauthCredentialId?: string
  baseURL?: string
  /**
   * @deprecated Legacy plaintext value. It is never used for requests; new
   * profiles persist apiKeyEnv instead.
   */
  apiKey: string
  /** Environment variable name used to resolve the key at runtime. */
  apiKeyEnv?: string
  maxTokens: number
  contextLength: number
  reasoningEffort?: 'low' | 'medium' | 'high' | 'minimal' | string
  requestStrategy?: RequestStrategy
  isActive: boolean
  createdAt: number
  lastUsed?: number
  isGPT5?: boolean
  validationStatus?: 'valid' | 'needs_repair' | 'auto_repaired'
  lastValidation?: number
}

export type ModelPointerType = 'main' | 'task' | 'compact' | 'quick'

export type ModelPointers = {
  main: string
  task: string
  compact: string
  quick: string
}

export type AccountInfo = {
  accountUuid: string
  emailAddress: string
  organizationUuid?: string
}

export type GlobalConfig = {
  projects?: Record<string, ProjectConfig>
  numStartups: number
  autoUpdaterStatus?: AutoUpdaterStatus
  userID?: string
  theme: ThemeNames
  editorMode?: 'normal' | 'vim' | 'emacs'
  thinkingMode?: 'auto' | 'enabled' | 'disabled'
  hasCompletedOnboarding?: boolean
  lastPlanModeUse?: number
  lastOnboardingVersion?: string
  lastReleaseNotesSeen?: string
  mcpServers?: Record<string, McpServerConfig>
  disabledMcpServers?: string[]
  preferredNotifChannel: NotificationChannel
  verbose: boolean
  useAlternateBuffer?: boolean
  incrementalRendering?: boolean
  wipeScrollbackOnClear?: boolean
  customApiKeyResponses?: {
    approved?: string[]
    rejected?: string[]
  }
  primaryProvider?: ProviderType
  maxTokens?: number
  hasAcknowledgedCostThreshold?: boolean
  oauthAccount?: AccountInfo
  proxy?: string
  stream?: boolean
  modelProfiles?: ModelProfile[]
  modelPointers?: ModelPointers
  defaultModelName?: string
  lastDismissedUpdateVersion?: string
  shiftEnterKeyBindingInstalled?: boolean
  /** Voice provider settings; API key material stays in the named environment variable. */
  voice?: Partial<VoiceConfig>
}

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = {
  numStartups: 0,
  autoUpdaterStatus: 'not_configured',
  theme: 'dark',
  editorMode: 'normal',
  thinkingMode: 'auto',
  preferredNotifChannel: 'iterm2',
  verbose: false,
  useAlternateBuffer: false,
  incrementalRendering: true,
  wipeScrollbackOnClear: false,
  primaryProvider: 'anthropic',
  disabledMcpServers: [],
  customApiKeyResponses: {
    approved: [],
    rejected: [],
  },
  stream: true,
  modelProfiles: [],
  modelPointers: {
    main: '',
    task: '',
    compact: '',
    quick: '',
  },
  lastDismissedUpdateVersion: undefined,
}

export const GLOBAL_CONFIG_KEYS = [
  'autoUpdaterStatus',
  'theme',
  'editorMode',
  'thinkingMode',
  'hasCompletedOnboarding',
  'lastOnboardingVersion',
  'lastReleaseNotesSeen',
  'verbose',
  'useAlternateBuffer',
  'incrementalRendering',
  'wipeScrollbackOnClear',
  'customApiKeyResponses',
  'primaryProvider',
  'preferredNotifChannel',
  'maxTokens',
] as const

export type GlobalConfigKey = (typeof GLOBAL_CONFIG_KEYS)[number]

export function isGlobalConfigKey(key: string): key is GlobalConfigKey {
  return GLOBAL_CONFIG_KEYS.includes(key as GlobalConfigKey)
}

export const PROJECT_CONFIG_KEYS = [
  'dontCrawlDirectory',
  'enableArchitectTool',
  'hasTrustDialogAccepted',
  'hasCompletedProjectOnboarding',
] as const

export type ProjectConfigKey = (typeof PROJECT_CONFIG_KEYS)[number]

export function isProjectConfigKey(key: string): key is ProjectConfigKey {
  return PROJECT_CONFIG_KEYS.includes(key as ProjectConfigKey)
}
