import type { Tool } from '@kode/tool-interface/Tool'
import type { RequestStrategy } from '#config'
import { LEGACY_ENV } from '#config/compat/legacyEnv'

export type RequestHeadersProfile = 'kode' | 'compat'
export type SystemPromptProfile = 'kode' | 'compat'
export type ToolProfile = 'kode' | 'compat'

export type RequestStrategyFallbackStep = {
  name: string
  headers: RequestHeadersProfile
  systemPrompt: SystemPromptProfile
  tools: ToolProfile
}

// Compatibility UA version for restricted-client providers.
const COMPAT_CLIENT_UA_VERSION = '2.1.2'
export const COMPAT_DEFAULT_TIMEOUT_MS = 600000

export const COMPAT_TOOL_ALLOWLIST = new Set<string>([
  'Task',
  'Bash',
  'TaskOutput',
  'TaskStop',
  'LS',
  'Glob',
  'Grep',
  'Read',
  'Edit',
  'Write',
  'NotebookEdit',
  'TaskCreate',
  'TaskList',
  'TaskGet',
  'TaskUpdate',
  'TodoWrite',
  'WebSearch',
  'WebFetch',
  'AskUserQuestion',
  'EnterPlanMode',
  'ExitPlanMode',
  'LSP',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'mcp',
  'MCPSearch',
])

const RESTRICTED_CLIENT_ONLY_ERROR_HINTS = [
  'claude code',
  'claude-code',
  'claude_code',
  'claude cli',
  'claude-cli',
  'official cli',
  'only for claude',
  'only allowed for claude',
  'claude-only',
]

const AUTH_ERROR_HINTS = [
  'invalid api key',
  'incorrect api key',
  'x-api-key',
  'api key',
  'unauthorized',
  'authentication',
]

const BILLING_ERROR_HINTS = [
  'insufficient',
  'balance',
  'billing',
  'quota',
  'payment required',
  'credit',
]

const NETWORK_ERROR_HINTS = [
  'timeout',
  'timed out',
  'network',
  'econn',
  'enotfound',
  'eai_again',
  'socket hang up',
  'connection refused',
]

type RequestFailureKind =
  'restricted_client_only' | 'auth' | 'billing' | 'network' | 'other'

function extractStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const record = error as Record<string, unknown>
  if (typeof record.status === 'number') return record.status
  const response = record.response as Record<string, unknown> | undefined
  if (response && typeof response.status === 'number') return response.status
  return undefined
}

function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function extractHintText(error: unknown): string {
  const message = extractMessage(error)
  const parts: string[] = [message]

  if (!error || typeof error !== 'object') return message
  const record = error as Record<string, unknown>

  const pushIfString = (value: unknown) => {
    if (typeof value !== 'string') return
    const trimmed = value.trim()
    if (!trimmed) return
    parts.push(trimmed)
  }

  pushIfString(record.name)
  pushIfString(record.code)
  pushIfString(record.type)

  const nestedError =
    record.error &&
    typeof record.error === 'object' &&
    !Array.isArray(record.error)
      ? (record.error as Record<string, unknown>)
      : null

  if (nestedError) {
    pushIfString(nestedError.name)
    pushIfString(nestedError.code)
    pushIfString(nestedError.type)
    pushIfString(nestedError.message)
  }

  const response =
    record.response &&
    typeof record.response === 'object' &&
    !Array.isArray(record.response)
      ? (record.response as Record<string, unknown>)
      : null

  if (response) {
    pushIfString(response.statusText)

    const responseData =
      response.data &&
      typeof response.data === 'object' &&
      !Array.isArray(response.data)
        ? (response.data as Record<string, unknown>)
        : null

    if (responseData) {
      pushIfString(responseData.message)
      const responseNested =
        responseData.error &&
        typeof responseData.error === 'object' &&
        !Array.isArray(responseData.error)
          ? (responseData.error as Record<string, unknown>)
          : null
      if (responseNested) {
        pushIfString(responseNested.type)
        pushIfString(responseNested.code)
        pushIfString(responseNested.message)
      }
    }
  }

  return parts.join('\n')
}

function hasAnyHint(message: string, hints: string[]): boolean {
  const normalized = message.toLowerCase()
  return hints.some(hint => normalized.includes(hint))
}

export function classifyRequestFailure(
  error: unknown,
  options?: { modelName?: string },
): {
  kind: RequestFailureKind
  message: string
  status?: number
} {
  const message = extractMessage(error)
  const hintText = extractHintText(error)
  const status = extractStatus(error)
  const modelName = options?.modelName
  const isClaudeModel =
    typeof modelName === 'string' && isClaudeModelName(modelName)

  if (hasAnyHint(hintText, RESTRICTED_CLIENT_ONLY_ERROR_HINTS)) {
    return { kind: 'restricted_client_only', message, status }
  }

  if (hasAnyHint(hintText, NETWORK_ERROR_HINTS)) {
    return { kind: 'network', message, status }
  }

  if (status === 401 || status === 403) {
    if (hasAnyHint(hintText, AUTH_ERROR_HINTS)) {
      return { kind: 'auth', message, status }
    }
  }

  if (status === 402 || hasAnyHint(hintText, BILLING_ERROR_HINTS)) {
    return { kind: 'billing', message, status }
  }

  if (hasAnyHint(hintText, AUTH_ERROR_HINTS)) {
    return { kind: 'auth', message, status }
  }

  // Some Anthropic-compatible gateways return a generic 403 for requests that must
  // match a specific client fingerprint (UA/headers/prompt/tools). Only treat this as
  // a "restricted client" signal when the selected model name looks like a Claude-family model
  // (to avoid misclassifying unrelated 403s).
  if (status === 403 && isClaudeModel) {
    return { kind: 'restricted_client_only', message, status }
  }

  return { kind: 'other', message, status }
}

export function shouldAttemptRestrictedClientFallback(
  error: unknown,
  modelName?: string,
): boolean {
  return (
    classifyRequestFailure(error, { modelName }).kind ===
    'restricted_client_only'
  )
}

export function isClaudeModelName(modelName: string): boolean {
  return modelName.toLowerCase().includes('claude')
}

export function buildCompatUserAgent(): string {
  // Compatibility UA builder. We mirror the default behavior ("cli" for TTY,
  // "sdk-cli" otherwise) to avoid emitting "undefined" in the UA.
  const entrypoint =
    process.env.KODE_ENTRYPOINT ??
    process.env[LEGACY_ENV.codeEntryPoint] ??
    (process.stdout.isTTY ? 'cli' : 'sdk-cli')

  const agentSdkVersion =
    process.env.KODE_AGENT_SDK_VERSION ??
    process.env[LEGACY_ENV.agentSdkVersion]

  const agentSdk = agentSdkVersion ? `, agent-sdk/${agentSdkVersion}` : ''

  return `claude-cli/${COMPAT_CLIENT_UA_VERSION} (external, ${entrypoint}${agentSdk})`
}

function parseAnthropicCustomHeaders(): Record<string, string> {
  const raw = process.env.ANTHROPIC_CUSTOM_HEADERS
  if (!raw) return {}
  const out: Record<string, string> = {}
  const lines = raw.split(/\n|\r\n/)
  for (const line of lines) {
    if (!line.trim()) continue
    const match = line.match(/^\s*(.*?)\s*:\s*(.*?)\s*$/)
    if (!match) continue
    const [, key, value] = match
    if (key && value !== undefined) {
      out[key] = value
    }
  }
  return out
}

function isTruthyEnvVar(value: string | undefined): boolean {
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

export function buildCompatHeaders(options?: {
  includeAuthToken?: boolean
}): Record<string, string> {
  const headers: Record<string, string> = {
    'x-app': 'cli',
    'User-Agent': buildCompatUserAgent(),
    ...parseAnthropicCustomHeaders(),
  }

  const shouldIncludeAuthToken = options?.includeAuthToken !== false
  if (shouldIncludeAuthToken && process.env.ANTHROPIC_AUTH_TOKEN) {
    // Add Authorization when ANTHROPIC_AUTH_TOKEN is available (some gateways check it).
    headers.Authorization = `Bearer ${process.env.ANTHROPIC_AUTH_TOKEN}`
  }

  const containerId =
    process.env.KODE_REMOTE_CONTAINER_ID ??
    process.env[LEGACY_ENV.codeContainerId]
  if (containerId && containerId.trim()) {
    headers['x-claude-remote-container-id'] = containerId.trim()
  }

  const remoteSessionId =
    process.env.KODE_REMOTE_SESSION_ID ??
    process.env[LEGACY_ENV.codeRemoteSessionId]
  if (remoteSessionId && remoteSessionId.trim()) {
    headers['x-claude-remote-session-id'] = remoteSessionId.trim()
  }

  if (
    isTruthyEnvVar(
      process.env.KODE_ADDITIONAL_PROTECTION ??
        process.env[LEGACY_ENV.codeAdditionalProtection],
    )
  ) {
    headers['x-anthropic-additional-protection'] = 'true'
  }

  return headers
}

export function buildRequestStrategyFallbackPlan(
  strategy: RequestStrategy | undefined,
  modelName: string,
): RequestStrategyFallbackStep[] {
  const resolved = strategy ?? 'auto'
  const normalized =
    resolved === 'claude_code_headers'
      ? 'compat_headers'
      : resolved === 'claude_code_headers_system'
        ? 'compat_headers_system'
        : resolved === 'claude_code_full'
          ? 'compat_full'
          : resolved

  if (normalized === 'kode') {
    return [
      {
        name: 'kode-default',
        headers: 'kode',
        systemPrompt: 'kode',
        tools: 'kode',
      },
    ]
  }

  if (normalized === 'compat_headers') {
    return [
      {
        name: 'compat-headers',
        headers: 'compat',
        systemPrompt: 'kode',
        tools: 'kode',
      },
    ]
  }

  if (normalized === 'compat_headers_system') {
    return [
      {
        name: 'compat-headers-system',
        headers: 'compat',
        systemPrompt: 'compat',
        tools: 'kode',
      },
    ]
  }

  if (normalized === 'compat_full') {
    return [
      {
        name: 'compat-full',
        headers: 'compat',
        systemPrompt: 'compat',
        tools: 'compat',
      },
    ]
  }

  if (!isClaudeModelName(modelName)) {
    return [
      {
        name: 'kode-default',
        headers: 'kode',
        systemPrompt: 'kode',
        tools: 'kode',
      },
    ]
  }

  return [
    {
      name: 'kode-default',
      headers: 'kode',
      systemPrompt: 'kode',
      tools: 'kode',
    },
    {
      name: 'compat-headers',
      headers: 'compat',
      systemPrompt: 'kode',
      tools: 'kode',
    },
    {
      name: 'compat-headers-system',
      headers: 'compat',
      systemPrompt: 'compat',
      tools: 'kode',
    },
    {
      name: 'compat-full',
      headers: 'compat',
      systemPrompt: 'compat',
      tools: 'compat',
    },
  ]
}

export function filterToolsForCompatProfile(tools: Tool[]): Tool[] {
  return tools.filter(tool => {
    if (COMPAT_TOOL_ALLOWLIST.has(tool.name)) return true
    // Keep MCP dynamically-mounted tools even in "baseline tools only" mode.
    if (tool.name.startsWith('mcp__')) return true
    return false
  })
}
