import { mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getCwd } from '@kode/runtime/cwd'
import { getKodeAgentSessionId } from '#protocol/utils/kodeAgentSessionId'
import type { PreToolUseHookOutcome } from './types'
import { getDisableAllHooksState } from './disableAllHooks'
import {
  asRecord,
  getHookAdditionalContext,
  getHookPermissionDecision,
  getHookSystemMessage,
  getHookUpdatedInput,
} from './types'
import {
  coerceHookMessage,
  coerceHookPermissionMode,
  executeHooksForMatchers,
  hookValueForPrompt,
  tryParseHookJson,
} from './executor'
import {
  loadPluginMatchers,
  loadSettingsMatchers,
  matcherMatchesTool,
} from './registry'
import { logError } from './log'
type HookRuntimeState = {
  transcriptPath?: string
  queuedSystemMessages: string[]
  queuedAdditionalContexts: string[]
}
const HOOK_RUNTIME_STATE_KEY = '__kodeHookRuntimeState'
function isHookRuntimeState(value: unknown): value is HookRuntimeState {
  const record = asRecord(value)
  if (!record) return false
  const systemMessages = record.queuedSystemMessages
  const additionalContexts = record.queuedAdditionalContexts
  return (
    Array.isArray(systemMessages) &&
    systemMessages.every(item => typeof item === 'string') &&
    Array.isArray(additionalContexts) &&
    additionalContexts.every(item => typeof item === 'string') &&
    (record.transcriptPath === undefined ||
      typeof record.transcriptPath === 'string')
  )
}
function getHookRuntimeState(toolUseContext: unknown): HookRuntimeState {
  const contextRecord = asRecord(toolUseContext)
  const existing = contextRecord?.[HOOK_RUNTIME_STATE_KEY]
  if (isHookRuntimeState(existing)) return existing

  const created: HookRuntimeState = {
    transcriptPath: undefined,
    queuedSystemMessages: [],
    queuedAdditionalContexts: [],
  }
  if (contextRecord) contextRecord[HOOK_RUNTIME_STATE_KEY] = created
  return created
}
export function updateHookTranscriptForMessages(
  toolUseContext: unknown,
  messages: unknown[],
): void {
  const state = getHookRuntimeState(toolUseContext)
  const sessionId = getKodeAgentSessionId()

  const dir = join(tmpdir(), 'kode-hooks-transcripts')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* no-op */
  }

  if (!state.transcriptPath) {
    state.transcriptPath = join(dir, `${sessionId}.transcript.txt`)
  }

  const lines: string[] = []
  for (const msg of messages) {
    const msgRecord = asRecord(msg)
    if (!msgRecord) continue
    if (msgRecord.isMeta === true) continue
    const msgType = msgRecord.type
    if (msgType !== 'user' && msgType !== 'assistant') continue

    const messageRecord = asRecord(msgRecord.message)
    const content = messageRecord?.content

    if (msgType === 'user') {
      if (typeof content === 'string') {
        lines.push(`user: ${content}`)
        continue
      }
      if (Array.isArray(content)) {
        const parts: string[] = []
        for (const block of content) {
          const blockRecord = asRecord(block)
          if (!blockRecord) continue
          if (blockRecord.type === 'text') {
            parts.push(String(blockRecord.text ?? ''))
          }
          if (blockRecord.type === 'tool_result') {
            parts.push(`[tool_result] ${String(blockRecord.content ?? '')}`)
          }
        }
        lines.push(`user: ${parts.join('')}`)
      }
      continue
    }

    if (typeof content === 'string') {
      lines.push(`assistant: ${content}`)
      continue
    }
    if (!Array.isArray(content)) continue

    const parts: string[] = []
    for (const block of content) {
      const blockRecord = asRecord(block)
      if (!blockRecord) continue
      if (blockRecord.type === 'text')
        parts.push(String(blockRecord.text ?? ''))
      if (
        blockRecord.type === 'tool_use' ||
        blockRecord.type === 'server_tool_use'
      ) {
        parts.push(
          `[tool_use:${String(blockRecord.name ?? '')}] ${hookValueForPrompt(blockRecord.input)}`,
        )
      }
      if (blockRecord.type === 'mcp_tool_use') {
        parts.push(
          `[mcp_tool_use:${String(blockRecord.name ?? '')}] ${hookValueForPrompt(blockRecord.input)}`,
        )
      }
    }
    lines.push(`assistant: ${parts.join('')}`)
  }

  try {
    writeFileSync(state.transcriptPath, lines.join('\n') + '\n', 'utf8')
  } catch {
    /* no-op */
  }
}
export function drainHookSystemPromptAdditions(
  toolUseContext: unknown,
): string[] {
  const state = getHookRuntimeState(toolUseContext)
  const systemMessages = state.queuedSystemMessages.splice(
    0,
    state.queuedSystemMessages.length,
  )
  const contexts = state.queuedAdditionalContexts.splice(
    0,
    state.queuedAdditionalContexts.length,
  )

  const additions: string[] = []
  if (systemMessages.length > 0) {
    additions.push(
      ['\n# Hook system messages', ...systemMessages.map(m => m.trim())]
        .filter(Boolean)
        .join('\n\n'),
    )
  }
  if (contexts.length > 0) {
    additions.push(
      ['\n# Hook additional context', ...contexts.map(m => m.trim())]
        .filter(Boolean)
        .join('\n\n'),
    )
  }
  return additions
}
export function getHookTranscriptPath(
  toolUseContext: unknown,
): string | undefined {
  return getHookRuntimeState(toolUseContext).transcriptPath
}
export function queueHookSystemMessages(
  toolUseContext: unknown,
  messages: string[],
): void {
  const state = getHookRuntimeState(toolUseContext)
  for (const msg of messages) {
    const trimmed = String(msg ?? '').trim()
    if (trimmed) state.queuedSystemMessages.push(trimmed)
  }
}

export function queueHookAdditionalContexts(
  toolUseContext: unknown,
  contexts: string[],
): void {
  const state = getHookRuntimeState(toolUseContext)
  for (const ctx of contexts) {
    const trimmed = String(ctx ?? '').trim()
    if (trimmed) state.queuedAdditionalContexts.push(trimmed)
  }
}

export async function runPreToolUseHooks(args: {
  toolName: string
  toolInput: Record<string, unknown>
  toolUseId: string
  permissionMode?: unknown
  cwd?: string
  transcriptPath?: string
  safeMode?: boolean
  signal?: AbortSignal
}): Promise<PreToolUseHookOutcome> {
  const projectDir = args.cwd ?? getCwd()
  if (getDisableAllHooksState({ projectDir }).disabled) {
    return { kind: 'allow', warnings: [] }
  }

  const matchers = [
    ...loadSettingsMatchers(projectDir, 'PreToolUse'),
    ...loadPluginMatchers(projectDir, 'PreToolUse'),
  ]
  if (matchers.length === 0) return { kind: 'allow', warnings: [] }

  const applicable = matchers.filter(m =>
    matcherMatchesTool(m.matcher, args.toolName),
  )
  if (applicable.length === 0) return { kind: 'allow', warnings: [] }

  const hookInput: Record<string, unknown> = {
    session_id: getKodeAgentSessionId(),
    transcript_path: args.transcriptPath,
    cwd: projectDir,
    hook_event_name: 'PreToolUse',
    permission_mode: coerceHookPermissionMode(args.permissionMode),
    tool_name: args.toolName,
    tool_input: args.toolInput,
    tool_use_id: args.toolUseId,
  }

  const warnings: string[] = []
  const systemMessages: string[] = []
  const additionalContexts: string[] = []

  let mergedUpdatedInput: Record<string, unknown> | undefined
  let permissionDecision: 'allow' | 'ask' | null = null

  const settled = await executeHooksForMatchers({
    matchers: applicable,
    hookEvent: 'PreToolUse',
    hookInput,
    cwd: projectDir,
    safeMode: args.safeMode ?? false,
    parentSignal: args.signal,
    promptFallbackTimeoutMs: 30_000,
    commandFallbackTimeoutMs: 600_000,
  })

  for (const item of settled) {
    if (item.status === 'rejected') {
      logError(item.reason)
      warnings.push(`Hook failed to run: ${String(item.reason ?? '')}`)
      continue
    }

    const { result } = item.value

    if (result.exitCode === 2) {
      return {
        kind: 'block',
        message: coerceHookMessage(result.stdout, result.stderr),
      }
    }

    if (result.exitCode !== 0) {
      warnings.push(coerceHookMessage(result.stdout, result.stderr))
      continue
    }

    const json = tryParseHookJson(result.stdout)
    if (!json) continue

    const systemMessage = getHookSystemMessage(json)
    if (systemMessage) systemMessages.push(systemMessage)

    const additional = getHookAdditionalContext(json)
    if (additional) additionalContexts.push(additional)

    const decision = getHookPermissionDecision(json)
    if (decision === 'deny') {
      const msg =
        systemMessages.length > 0
          ? systemMessages.join('\n\n')
          : coerceHookMessage(result.stdout, result.stderr)
      return { kind: 'block', message: msg, systemMessages, additionalContexts }
    }

    if (decision === 'ask') {
      permissionDecision = 'ask'
    } else if (decision === 'allow') {
      if (!permissionDecision) permissionDecision = 'allow'
    }

    const updated = getHookUpdatedInput(json)
    if (updated) {
      mergedUpdatedInput = { ...(mergedUpdatedInput ?? {}), ...updated }
    }
  }

  return {
    kind: 'allow',
    warnings,
    permissionDecision:
      permissionDecision === 'allow'
        ? 'allow'
        : permissionDecision === 'ask'
          ? 'ask'
          : undefined,
    updatedInput:
      permissionDecision === 'allow' ? mergedUpdatedInput : undefined,
    systemMessages,
    additionalContexts,
  }
}

export async function runPostToolUseHooks(args: {
  toolName: string
  toolInput: Record<string, unknown>
  toolResult: unknown
  toolUseId: string
  permissionMode?: unknown
  cwd?: string
  transcriptPath?: string
  safeMode?: boolean
  signal?: AbortSignal
}): Promise<{
  warnings: string[]
  systemMessages: string[]
  additionalContexts: string[]
}> {
  const projectDir = args.cwd ?? getCwd()
  if (getDisableAllHooksState({ projectDir }).disabled) {
    return { warnings: [], systemMessages: [], additionalContexts: [] }
  }

  const matchers = [
    ...loadSettingsMatchers(projectDir, 'PostToolUse'),
    ...loadPluginMatchers(projectDir, 'PostToolUse'),
  ]
  if (matchers.length === 0) {
    return { warnings: [], systemMessages: [], additionalContexts: [] }
  }

  const applicable = matchers.filter(m =>
    matcherMatchesTool(m.matcher, args.toolName),
  )
  if (applicable.length === 0) {
    return { warnings: [], systemMessages: [], additionalContexts: [] }
  }

  const hookInput: Record<string, unknown> = {
    session_id: getKodeAgentSessionId(),
    transcript_path: args.transcriptPath,
    cwd: projectDir,
    hook_event_name: 'PostToolUse',
    permission_mode: coerceHookPermissionMode(args.permissionMode),
    tool_name: args.toolName,
    tool_input: args.toolInput,
    tool_result: args.toolResult,
    tool_response: args.toolResult,
    tool_use_id: args.toolUseId,
  }

  const warnings: string[] = []
  const systemMessages: string[] = []
  const additionalContexts: string[] = []

  const settled = await executeHooksForMatchers({
    matchers: applicable,
    hookEvent: 'PostToolUse',
    hookInput,
    cwd: projectDir,
    safeMode: args.safeMode ?? false,
    parentSignal: args.signal,
    promptFallbackTimeoutMs: 30_000,
    commandFallbackTimeoutMs: 600_000,
  })

  for (const item of settled) {
    if (item.status === 'rejected') {
      logError(item.reason)
      warnings.push(`Hook failed to run: ${String(item.reason ?? '')}`)
      continue
    }

    const { result } = item.value
    if (result.exitCode !== 0) {
      warnings.push(coerceHookMessage(result.stdout, result.stderr))
      continue
    }

    const json = tryParseHookJson(result.stdout)
    if (!json) continue

    const systemMessage = getHookSystemMessage(json)
    if (systemMessage) systemMessages.push(systemMessage)

    const additional = getHookAdditionalContext(json)
    if (additional) additionalContexts.push(additional)
  }

  return { warnings, systemMessages, additionalContexts }
}
