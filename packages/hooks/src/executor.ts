import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

import type { Hook, HookEventName, HookMatcher, PromptHook } from './types'
import { asRecord } from './types'
import { buildHookExecEnv } from './hookEnv'
import { getPromptHookQueryProvider } from './promptQuery'

export type HookExecutionResult = {
  exitCode: number
  stdout: string
  stderr: string
}
export type HookExecution = { hook: Hook; result: HookExecutionResult }

type CommandInvocation = {
  command: string
  args: string[]
}

function expandCommandEnv(
  command: string,
  env: Record<string, string>,
): string {
  return command.replace(/\$\{([^}]+)\}/g, (match, rawKey) => {
    const raw = String(rawKey ?? '')
    const [keyPart, defaultValue] = raw.split(':-', 2)
    const key = String(keyPart ?? '').trim()
    if (!key) return match
    const value = env[key] ?? process.env[key]
    if (value !== undefined) return value
    return defaultValue !== undefined ? defaultValue : match
  })
}

function hasUnquotedWindowsShellSyntax(command: string): boolean {
  let quote: '"' | "'" | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote) {
      if (ch === '\\' && command[i + 1] === quote) {
        i++
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch && '&|<>()^%!'.includes(ch)) return true
  }
  return false
}

function parseSimpleWindowsCommand(
  command: string,
): { command: string; args: string[]; hadQuotes: boolean } | null {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let hadQuotes = false

  const pushCurrent = () => {
    if (current.length === 0) return
    tokens.push(current)
    current = ''
  }

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote) {
      if (ch === '\\' && command[i + 1] === quote) {
        current += quote
        i++
        continue
      }
      if (ch === quote) {
        quote = null
        continue
      }
      current += ch
      continue
    }

    if (ch === '"' || ch === "'") {
      quote = ch
      hadQuotes = true
      continue
    }

    if (!ch || /\s/.test(ch)) {
      pushCurrent()
      continue
    }

    current += ch
  }

  if (quote) return null
  pushCurrent()
  if (tokens.length === 0) return null

  const [file, ...args] = tokens
  if (!file) return null
  return { command: file, args, hadQuotes }
}

function isFile(value: string): boolean {
  try {
    return statSync(value).isFile()
  } catch {
    return false
  }
}

function hasPathSeparator(value: string): boolean {
  return value.includes('\\') || value.includes('/')
}

function resolveWindowsExecutable(
  command: string,
  env: Record<string, string>,
): string {
  if (command.toLowerCase() === 'bun' && isFile(process.execPath)) {
    return process.execPath
  }

  if (isAbsolute(command) || hasPathSeparator(command)) return command

  const pathValue =
    env.Path ?? env.PATH ?? process.env.Path ?? process.env.PATH ?? ''
  const pathExt = env.PATHEXT ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD'
  const extensions = ['', ...pathExt.split(';')].map(ext => ext.toLowerCase())
  const commandLower = command.toLowerCase()
  const hasKnownExt = extensions.some(
    ext => ext.length > 0 && commandLower.endsWith(ext),
  )

  for (const dir of pathValue.split(delimiter)) {
    if (!dir.trim()) continue
    const candidates = hasKnownExt
      ? [join(dir, command)]
      : extensions.map(ext => join(dir, `${command}${ext}`))
    for (const candidate of candidates) {
      if (existsSync(candidate) && isFile(candidate)) return candidate
    }
  }

  return command
}

function buildShellCommand(command: string): CommandInvocation {
  if (process.platform === 'win32') {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', command] }
  }
  return { command: '/bin/sh', args: ['-c', command] }
}

function buildCommandInvocation(
  command: string,
  env: Record<string, string>,
): CommandInvocation {
  const expanded = expandCommandEnv(command, env)

  if (
    process.platform === 'win32' &&
    !hasUnquotedWindowsShellSyntax(expanded)
  ) {
    const parsed = parseSimpleWindowsCommand(expanded)
    if (parsed?.hadQuotes) {
      return {
        command: resolveWindowsExecutable(parsed.command, env),
        args: parsed.args,
      }
    }
  }

  return buildShellCommand(expanded)
}

export async function runCommandHook(args: {
  command: string
  stdinJson: unknown
  cwd: string
  env?: Record<string, string>
  signal?: AbortSignal
}): Promise<HookExecutionResult> {
  let proc: ReturnType<typeof spawn>
  try {
    const env = { ...process.env, ...(args.env ?? {}) } as Record<
      string,
      string
    >
    const cmd = buildCommandInvocation(args.command, env)
    proc = spawn(cmd.command, cmd.args, {
      cwd: args.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (err) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
    }
  }

  const onAbort = () => {
    try {
      proc.kill()
    } catch {
      /* no-op */
    }
  }
  if (args.signal) {
    if (args.signal.aborted) onAbort()
    args.signal.addEventListener('abort', onAbort, { once: true })
  }

  try {
    const input = JSON.stringify(args.stdinJson)
    proc.stdin?.write(input)
    proc.stdin?.end()

    let stdout = ''
    let stderr = ''

    if (proc.stdout) {
      proc.stdout.setEncoding('utf8')
      proc.stdout.on('data', chunk => {
        stdout += chunk
      })
    }
    if (proc.stderr) {
      proc.stderr.setEncoding('utf8')
      proc.stderr.on('data', chunk => {
        stderr += chunk
      })
    }

    const exitCode = await new Promise<number>(resolve => {
      proc.once('exit', code => resolve(code ?? 0))
      proc.once('error', err => {
        stderr = [stderr, err instanceof Error ? err.message : String(err)]
          .filter(Boolean)
          .join('\n')
        resolve(2)
      })
    })

    return { exitCode, stdout, stderr }
  } finally {
    if (args.signal) {
      try {
        args.signal.removeEventListener('abort', onAbort)
      } catch {
        /* no-op */
      }
    }
  }
}

function mergeAbortSignals(signals: Array<AbortSignal | undefined>): {
  signal: AbortSignal
  cleanup: () => void
} {
  const controller = new AbortController()
  const onAbort = () => controller.abort()

  const cleanups: Array<() => void> = []
  for (const signal of signals) {
    if (!signal) continue
    if (signal.aborted) {
      controller.abort()
      continue
    }
    signal.addEventListener('abort', onAbort, { once: true })
    cleanups.push(() => {
      try {
        signal.removeEventListener('abort', onAbort)
      } catch {
        /* no-op */
      }
    })
  }

  return {
    signal: controller.signal,
    cleanup: () => cleanups.forEach(fn => fn()),
  }
}

function withHookTimeout(args: {
  timeoutSeconds?: number
  parentSignal?: AbortSignal
  fallbackTimeoutMs: number
}): { signal: AbortSignal; cleanup: () => void } {
  type TimeoutSignal = AbortSignal & { __cleanup?: () => void }
  type AbortSignalTimeoutFactory = { timeout?: (ms: number) => AbortSignal }

  const timeoutMs =
    typeof args.timeoutSeconds === 'number' &&
    Number.isFinite(args.timeoutSeconds)
      ? Math.max(0, Math.floor(args.timeoutSeconds * 1000))
      : args.fallbackTimeoutMs

  const timeoutFactory = AbortSignal as unknown as AbortSignalTimeoutFactory
  const timeoutSignal: TimeoutSignal =
    typeof timeoutFactory.timeout === 'function'
      ? timeoutFactory.timeout(timeoutMs)
      : (() => {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), timeoutMs)
          const signal: TimeoutSignal = controller.signal
          signal.__cleanup = () => clearTimeout(timer)
          return signal
        })()

  const merged = mergeAbortSignals([args.parentSignal, timeoutSignal])
  const timeoutCleanup =
    typeof timeoutSignal.__cleanup === 'function'
      ? timeoutSignal.__cleanup
      : () => {}

  return {
    signal: merged.signal,
    cleanup: () => {
      merged.cleanup()
      timeoutCleanup()
    },
  }
}

export function coerceHookMessage(stdout: string, stderr: string): string {
  const s = (stderr || '').trim()
  if (s) return s
  const o = (stdout || '').trim()
  if (o) return o
  return 'Hook blocked the tool call.'
}

export function coerceHookPermissionMode(mode: unknown): 'ask' | 'allow' {
  if (mode === 'acceptEdits') return 'allow'
  return 'ask'
}

export function extractFirstJsonObject(text: string): string | null {
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]

    if (start === -1) {
      if (ch === '{') {
        start = i
        depth = 1
      }
      continue
    }

    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === '"') {
        inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
      continue
    }

    if (ch === '{') {
      depth++
      continue
    }
    if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }

  return null
}

export function tryParseHookJson(
  stdout: string,
): Record<string, unknown> | null {
  const trimmed = String(stdout ?? '').trim()
  if (!trimmed) return null
  const jsonStr = extractFirstJsonObject(trimmed) ?? trimmed
  try {
    const parsed = JSON.parse(jsonStr)
    return asRecord(parsed)
  } catch {
    return null
  }
}

export function hookValueForPrompt(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function interpolatePromptHookTemplate(
  template: string,
  hookInput: Record<string, unknown>,
): string {
  return String(template ?? '')
    .replaceAll('$TOOL_INPUT', hookValueForPrompt(hookInput.tool_input))
    .replaceAll('$TOOL_RESULT', hookValueForPrompt(hookInput.tool_result))
    .replaceAll('$TOOL_RESPONSE', hookValueForPrompt(hookInput.tool_response))
    .replaceAll('$USER_PROMPT', hookValueForPrompt(hookInput.user_prompt))
    .replaceAll('$PROMPT', hookValueForPrompt(hookInput.prompt))
    .replaceAll('$REASON', hookValueForPrompt(hookInput.reason))
}

function extractAssistantText(message: unknown): string {
  const record = asRecord(message)
  const messageRecord = asRecord(record?.message)
  const content = messageRecord?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  const parts: string[] = []
  for (const block of content) {
    const blockRecord = asRecord(block)
    if (!blockRecord) continue
    if (blockRecord.type === 'text') parts.push(String(blockRecord.text ?? ''))
  }
  return parts.join('')
}

async function runPromptHook(args: {
  hook: PromptHook
  hookEvent: HookEventName
  hookInput: Record<string, unknown>
  safeMode: boolean
  parentSignal?: AbortSignal
  fallbackTimeoutMs: number
}): Promise<HookExecutionResult> {
  const { signal, cleanup } = withHookTimeout({
    timeoutSeconds: args.hook.timeout,
    parentSignal: args.parentSignal,
    fallbackTimeoutMs: args.fallbackTimeoutMs,
  })

  try {
    const queryQuick = getPromptHookQueryProvider()
    if (!queryQuick) {
      throw new Error('Prompt hook query provider is not configured')
    }

    const systemPrompt = [
      'You are executing a Kode prompt hook.',
      'Return a single JSON object only (no markdown, no prose).',
      `hook_event_name: ${args.hookEvent}`,
      'Valid fields include:',
      '- systemMessage: string',
      '- decision: \"approve\" | \"block\" (Stop/SubagentStop only)',
      '- reason: string (Stop/SubagentStop only)',
      '- hookSpecificOutput.permissionDecision: \"allow\" | \"deny\" | \"ask\" | \"passthrough\" (PreToolUse only)',
      '- hookSpecificOutput.updatedInput: object (PreToolUse only)',
      '- hookSpecificOutput.additionalContext: string (SessionStart/any)',
    ]

    const promptText = interpolatePromptHookTemplate(
      args.hook.prompt,
      args.hookInput,
    )
    const userPrompt = `${promptText}\n\n# Hook input JSON\n${hookValueForPrompt(args.hookInput)}`

    const response = await queryQuick({
      systemPrompt,
      userPrompt,
      signal,
    })

    return { exitCode: 0, stdout: extractAssistantText(response), stderr: '' }
  } catch (err) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
    }
  } finally {
    cleanup()
  }
}

export async function executeHooksForMatchers(args: {
  matchers: HookMatcher[]
  hookEvent: HookEventName
  hookInput: Record<string, unknown>
  cwd: string
  safeMode: boolean
  parentSignal?: AbortSignal
  promptFallbackTimeoutMs: number
  commandFallbackTimeoutMs: number
  baseEnv?: Record<string, string>
}): Promise<Array<PromiseSettledResult<HookExecution>>> {
  const executions: Array<Promise<HookExecution>> = []

  for (const entry of args.matchers) {
    for (const hook of entry.hooks) {
      if (hook.type === 'prompt') {
        executions.push(
          runPromptHook({
            hook,
            hookEvent: args.hookEvent,
            hookInput: args.hookInput,
            safeMode: args.safeMode,
            parentSignal: args.parentSignal,
            fallbackTimeoutMs: args.promptFallbackTimeoutMs,
          }).then(result => ({ hook, result })),
        )
        continue
      }

      const { signal, cleanup } = withHookTimeout({
        timeoutSeconds: hook.timeout,
        parentSignal: args.parentSignal,
        fallbackTimeoutMs: args.commandFallbackTimeoutMs,
      })

      const env: Record<string, string> = {
        ...buildHookExecEnv({
          projectDir: args.cwd,
          pluginRoot: hook.pluginRoot,
        }),
        ...(args.baseEnv ?? {}),
      }

      executions.push(
        runCommandHook({
          command: hook.command,
          stdinJson: args.hookInput,
          cwd: args.cwd,
          env,
          signal,
        })
          .then(result => ({ hook, result }))
          .finally(cleanup),
      )
    }
  }

  return Promise.allSettled(executions)
}
