import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { getCwd } from '@kode/runtime/cwd'
import { getKodeAgentSessionId } from '#protocol/utils/kodeAgentSessionId'

import type { CommandHook } from '../types'
import { asRecord } from '../types'
import { getDisableAllHooksState } from '../disableAllHooks'
import { buildHookExecEnv } from '../hookEnv'
import { getSessionPlugins } from '../sessionPlugins'
import {
  coerceHookPermissionMode,
  extractFirstJsonObject,
  runCommandHook,
} from '../executor'

const sessionStartCache = new Map<string, { additionalContext: string }>()

function isCommandHook(value: unknown): value is CommandHook {
  const record = asRecord(value)
  if (!record) return false
  if (record.type !== 'command') return false
  const command = record.command
  return typeof command === 'string' && Boolean(command.trim())
}

function parseSessionStartHooks(value: unknown): CommandHook[] {
  if (!Array.isArray(value)) return []
  const out: CommandHook[] = []
  for (const item of value) {
    const record = asRecord(item)
    if (!record) continue
    const hooksRaw = record.hooks
    const hooks = Array.isArray(hooksRaw) ? hooksRaw.filter(isCommandHook) : []
    out.push(...hooks)
  }
  return out
}

function parseSessionStartAdditionalContext(stdout: string): string | null {
  const trimmed = String(stdout ?? '').trim()
  if (!trimmed) return null

  const jsonStr = extractFirstJsonObject(trimmed) ?? trimmed
  try {
    const parsed = JSON.parse(jsonStr)
    const parsedRecord = asRecord(parsed)
    const hookSpecificOutput = asRecord(parsedRecord?.hookSpecificOutput)
    const additional =
      typeof hookSpecificOutput?.additionalContext === 'string'
        ? hookSpecificOutput.additionalContext
        : null
    return additional && additional.trim() ? additional : null
  } catch {
    return null
  }
}

function applyEnvFileToProcessEnv(envFilePath: string): void {
  let raw: string
  try {
    raw = readFileSync(envFilePath, 'utf8')
  } catch {
    return
  }

  const lines = raw.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const withoutExport = trimmed.startsWith('export ')
      ? trimmed.slice('export '.length).trim()
      : trimmed

    const eq = withoutExport.indexOf('=')
    if (eq <= 0) continue

    const key = withoutExport.slice(0, eq).trim()
    let value = withoutExport.slice(eq + 1).trim()
    if (!key) continue

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    process.env[key] = value
  }
}

export async function getSessionStartAdditionalContext(args?: {
  permissionMode?: unknown
  cwd?: string
  signal?: AbortSignal
}): Promise<string> {
  const sessionId = getKodeAgentSessionId()
  const cached = sessionStartCache.get(sessionId)
  if (cached) return cached.additionalContext

  const projectDir = args?.cwd ?? getCwd()
  if (getDisableAllHooksState({ projectDir }).disabled) {
    sessionStartCache.set(sessionId, { additionalContext: '' })
    return ''
  }

  const plugins = getSessionPlugins()
  if (plugins.length === 0) {
    sessionStartCache.set(sessionId, { additionalContext: '' })
    return ''
  }

  const envFileDir = mkdtempSync(join(tmpdir(), 'kode-env-'))
  const envFilePath = join(envFileDir, `${sessionId}.env`)
  try {
    writeFileSync(envFilePath, '', 'utf8')
  } catch {
    // ignore
  }

  const additionalContexts: string[] = []

  try {
    for (const plugin of plugins) {
      for (const hookPath of plugin.hooksFiles ?? []) {
        let hookObj: unknown
        try {
          const raw = readFileSync(hookPath, 'utf8')
          const parsed = JSON.parse(raw) as { hooks?: unknown }
          hookObj =
            parsed && typeof parsed === 'object' && parsed.hooks
              ? parsed.hooks
              : parsed
        } catch {
          continue
        }

        const hookRecord = asRecord(hookObj)
        const hooks = parseSessionStartHooks(hookRecord?.SessionStart).map(
          h => ({
            ...h,
            pluginRoot: plugin.rootDir,
          }),
        )
        if (hooks.length === 0) continue

        for (const hook of hooks) {
          const payload = {
            session_id: sessionId,
            cwd: projectDir,
            hook_event_name: 'SessionStart',
            permission_mode: coerceHookPermissionMode(args?.permissionMode),
          }

          const result = await runCommandHook({
            command: hook.command,
            stdinJson: payload,
            cwd: projectDir,
            env: {
              ...buildHookExecEnv({
                projectDir,
                pluginRoot: hook.pluginRoot,
                envFilePath,
              }),
            },
            signal: args?.signal,
          })

          if (result.exitCode !== 0) continue
          const injected = parseSessionStartAdditionalContext(result.stdout)
          if (injected) additionalContexts.push(injected)
        }
      }

      const manifest = asRecord(plugin.manifest)
      const inlineHooks = manifest?.hooks
      if (
        inlineHooks &&
        typeof inlineHooks === 'object' &&
        !Array.isArray(inlineHooks)
      ) {
        const inlineHooksRecord = asRecord(inlineHooks)
        if (!inlineHooksRecord) continue
        const nestedHooks =
          inlineHooksRecord.hooks &&
          typeof inlineHooksRecord.hooks === 'object' &&
          !Array.isArray(inlineHooksRecord.hooks)
            ? asRecord(inlineHooksRecord.hooks)
            : null
        const hookObj = nestedHooks ?? inlineHooksRecord

        const hooks = parseSessionStartHooks(hookObj.SessionStart).map(h => ({
          ...h,
          pluginRoot: plugin.rootDir,
        }))
        if (hooks.length === 0) continue

        for (const hook of hooks) {
          const payload = {
            session_id: sessionId,
            cwd: projectDir,
            hook_event_name: 'SessionStart',
            permission_mode: coerceHookPermissionMode(args?.permissionMode),
          }

          const result = await runCommandHook({
            command: hook.command,
            stdinJson: payload,
            cwd: projectDir,
            env: {
              ...buildHookExecEnv({
                projectDir,
                pluginRoot: hook.pluginRoot,
                envFilePath,
              }),
            },
            signal: args?.signal,
          })

          if (result.exitCode !== 0) continue
          const injected = parseSessionStartAdditionalContext(result.stdout)
          if (injected) additionalContexts.push(injected)
        }
      }
    }
  } finally {
    applyEnvFileToProcessEnv(envFilePath)
    try {
      rmSync(envFileDir, { recursive: true, force: true })
    } catch {
      /* no-op */
    }
  }

  const additionalContext = additionalContexts.filter(Boolean).join('\n\n')
  sessionStartCache.set(sessionId, { additionalContext })
  return additionalContext
}

export function __resetSessionStartCacheForTests(): void {
  sessionStartCache.clear()
}
