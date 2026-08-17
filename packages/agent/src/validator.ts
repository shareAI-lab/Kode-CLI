import { readFileSync } from 'fs'
import { readFile } from 'fs/promises'
import { basename } from 'path'

import { z } from 'zod'

import { parseMarkdownFrontmatter } from '#config/frontmatter'
import { debug as debugLogger } from '#core/utils/debugLogger'
import { logError } from '#core/utils/log'

import type {
  AgentConfig,
  AgentLocation,
  AgentModel,
  AgentPermissionMode,
  AgentSource,
} from './types'

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function readMarkdownFile(
  filePath: string,
): { frontmatter: Record<string, unknown>; content: string } | null {
  try {
    const raw = readFileSync(filePath, 'utf8')
    return parseMarkdownFrontmatter(raw)
  } catch {
    return null
  }
}

async function readMarkdownFileAsync(
  filePath: string,
): Promise<{ frontmatter: Record<string, unknown>; content: string } | null> {
  try {
    const raw = await readFile(filePath, 'utf8')
    return parseMarkdownFrontmatter(raw)
  } catch {
    return null
  }
}

function splitCliList(values: string[]): string[] {
  if (values.length === 0) return []
  const out: string[] = []

  for (const value of values) {
    if (!value) continue
    let current = ''
    let inParens = false

    for (const ch of value) {
      switch (ch) {
        case '(':
          inParens = true
          current += ch
          break
        case ')':
          inParens = false
          current += ch
          break
        case ',':
          if (inParens) {
            current += ch
          } else {
            const trimmed = current.trim()
            if (trimmed) out.push(trimmed)
            current = ''
          }
          break
        case ' ':
          if (inParens) {
            current += ch
          } else {
            const trimmed = current.trim()
            if (trimmed) out.push(trimmed)
            current = ''
          }
          break
        default:
          current += ch
      }
    }

    const trimmed = current.trim()
    if (trimmed) out.push(trimmed)
  }

  return out
}

function normalizeToolList(value: unknown): string[] | null {
  if (value === undefined || value === null) return null
  if (!value) return []

  let raw: string[] = []
  if (typeof value === 'string') raw = [value]
  else if (Array.isArray(value))
    raw = value.filter((v): v is string => typeof v === 'string')

  if (raw.length === 0) return []
  const parsed = splitCliList(raw)
  if (parsed.includes('*')) return ['*']
  return parsed
}

function z2A(value: unknown): string[] | undefined {
  const normalized = normalizeToolList(value)
  if (normalized === null) return value === undefined ? undefined : []
  if (normalized.includes('*')) return undefined
  return normalized
}

function qP(value: unknown): string[] {
  const normalized = normalizeToolList(value)
  if (normalized === null) return []
  return normalized
}

const VALID_PERMISSION_MODES = [
  'acceptEdits',
  'cautious',
  'plan',
  'yolo',
  'default',
  'bypassPermissions',
  'dontAsk',
  'delegate',
] as const

function normalizeAgentPermissionMode(
  mode: (typeof VALID_PERMISSION_MODES)[number],
): AgentPermissionMode {
  switch (mode) {
    case 'acceptEdits':
    case 'cautious':
    case 'plan':
      return mode
    case 'yolo':
    case 'bypassPermissions':
      return 'acceptEdits'
    case 'default':
    case 'dontAsk':
    case 'delegate':
      return 'cautious'
  }
}

function sourceToLocation(source: AgentSource): AgentLocation {
  switch (source) {
    case 'plugin':
      return 'plugin'
    case 'userSettings':
      return 'user'
    case 'projectSettings':
      return 'project'
    case 'built-in':
    case 'flagSettings':
    case 'policySettings':
    default:
      return 'built-in'
  }
}

function parseAgentFromLoadedMarkdown(
  parsed: { frontmatter: Record<string, unknown>; content: string },
  options: {
    filePath: string
    baseDir: string
    source: Exclude<AgentSource, 'flagSettings' | 'built-in'>
  },
): AgentConfig | null {
  try {
    const fm = parsed.frontmatter ?? {}
    const name = fm.name
    const description = fm.description

    if (
      !name ||
      typeof name !== 'string' ||
      !description ||
      typeof description !== 'string'
    ) {
      return null
    }

    const whenToUse = description.replace(/\\n/g, '\n')
    const filename = basename(options.filePath, '.md')

    const color = typeof fm.color === 'string' ? fm.color : undefined

    let modelRaw: unknown = fm.model
    if (typeof modelRaw !== 'string' && typeof fm.model_name === 'string') {
      modelRaw = fm.model_name
    }
    let model = typeof modelRaw === 'string' ? modelRaw.trim() : undefined
    if (model === '') model = undefined

    const forkContextValue: unknown = fm.forkContext
    if (
      forkContextValue !== undefined &&
      forkContextValue !== true &&
      forkContextValue !== false &&
      forkContextValue !== 'true' &&
      forkContextValue !== 'false'
    ) {
      debugLogger.warn('AGENT_LOADER_INVALID_FORK_CONTEXT', {
        filePath: options.filePath,
        forkContext: String(forkContextValue),
      })
    }
    const forkContext = forkContextValue === true || forkContextValue === 'true'

    const maxExecutionTimeRaw =
      fm.maxExecutionTimeMs ??
      fm['max-execution-time-ms'] ??
      fm['max_execution_time_ms']
    const maxExecutionTimeMs =
      typeof maxExecutionTimeRaw === 'number' &&
      Number.isSafeInteger(maxExecutionTimeRaw) &&
      maxExecutionTimeRaw >= 1_000 &&
      maxExecutionTimeRaw <= 3_600_000
        ? maxExecutionTimeRaw
        : undefined
    if (maxExecutionTimeRaw !== undefined && maxExecutionTimeMs === undefined) {
      debugLogger.warn('AGENT_LOADER_INVALID_EXECUTION_TIMEOUT', {
        filePath: options.filePath,
        maxExecutionTimeMs: String(maxExecutionTimeRaw),
      })
      return null
    }

    if (forkContext && model && model !== 'inherit') {
      debugLogger.warn('AGENT_LOADER_FORK_CONTEXT_MODEL_OVERRIDE', {
        filePath: options.filePath,
        model,
      })
      model = 'inherit'
    }

    const permissionModeValue: unknown = fm.permissionMode
    const permissionModeIsValid =
      typeof permissionModeValue === 'string' &&
      VALID_PERMISSION_MODES.includes(
        permissionModeValue as AgentPermissionMode,
      )
    if (
      typeof permissionModeValue === 'string' &&
      permissionModeValue &&
      !permissionModeIsValid
    ) {
      debugLogger.warn('AGENT_LOADER_INVALID_PERMISSION_MODE', {
        filePath: options.filePath,
        permissionMode: permissionModeValue,
        valid: VALID_PERMISSION_MODES,
      })
    }

    const toolsList = z2A(fm.tools)
    const tools: string[] | '*' =
      toolsList === undefined || toolsList.includes('*') ? '*' : toolsList

    const disallowedRaw =
      fm.disallowedTools ?? fm['disallowed-tools'] ?? fm['disallowed_tools']
    const disallowedTools =
      disallowedRaw !== undefined ? z2A(disallowedRaw) : undefined

    const skills = qP(fm.skills)
    const systemPrompt = parsed.content.trim()

    const agent: AgentConfig = {
      agentType: name,
      whenToUse,
      tools,
      ...(disallowedTools !== undefined ? { disallowedTools } : {}),
      ...(skills.length > 0 ? { skills } : { skills: [] }),
      systemPrompt,
      source: options.source,
      location: sourceToLocation(options.source),
      baseDir: options.baseDir,
      filename,
      ...(color ? { color } : {}),
      ...(model ? { model: model as AgentModel } : {}),
      ...(permissionModeIsValid
        ? {
            permissionMode: normalizeAgentPermissionMode(
              permissionModeValue as (typeof VALID_PERMISSION_MODES)[number],
            ),
          }
        : {}),
      ...(forkContext ? { forkContext: true } : {}),
      ...(maxExecutionTimeMs ? { maxExecutionTimeMs } : {}),
    }

    return agent
  } catch {
    return null
  }
}

export function parseAgentFromFile(options: {
  filePath: string
  baseDir: string
  source: Exclude<AgentSource, 'flagSettings' | 'built-in'>
}): AgentConfig | null {
  const parsed = readMarkdownFile(options.filePath)
  if (!parsed) return null

  return parseAgentFromLoadedMarkdown(parsed, options)
}

export async function parseAgentFromFileAsync(options: {
  filePath: string
  baseDir: string
  source: Exclude<AgentSource, 'flagSettings' | 'built-in'>
}): Promise<AgentConfig | null> {
  const parsed = await readMarkdownFileAsync(options.filePath)
  if (!parsed) return null
  return parseAgentFromLoadedMarkdown(parsed, options)
}

const agentJsonSchema = z.object({
  description: z.string().min(1, 'Description cannot be empty'),
  tools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  prompt: z.string().min(1, 'Prompt cannot be empty'),
  model: z.string().optional(),
  permissionMode: z.enum(VALID_PERMISSION_MODES).optional(),
  maxExecutionTimeMs: z.number().int().min(1_000).max(3_600_000).optional(),
})

const agentsJsonSchema = z.record(z.string(), agentJsonSchema)

function parseAgentFromJson(
  agentType: string,
  value: unknown,
): AgentConfig | null {
  const parsed = agentJsonSchema.safeParse(value)
  if (!parsed.success) return null

  const toolsList = z2A(parsed.data.tools)
  const disallowedList =
    parsed.data.disallowedTools !== undefined
      ? z2A(parsed.data.disallowedTools)
      : undefined
  const model =
    typeof parsed.data.model === 'string' ? parsed.data.model.trim() : undefined

  return {
    agentType,
    whenToUse: parsed.data.description,
    tools: toolsList === undefined || toolsList.includes('*') ? '*' : toolsList,
    ...(disallowedList !== undefined
      ? { disallowedTools: disallowedList }
      : {}),
    systemPrompt: parsed.data.prompt,
    source: 'flagSettings',
    location: 'built-in',
    ...(model ? { model: model as AgentModel } : {}),
    ...(parsed.data.permissionMode
      ? {
          permissionMode: normalizeAgentPermissionMode(
            parsed.data.permissionMode,
          ),
        }
      : {}),
    ...(parsed.data.maxExecutionTimeMs
      ? { maxExecutionTimeMs: parsed.data.maxExecutionTimeMs }
      : {}),
  }
}

export function parseFlagAgentsFromCliJson(json: string): AgentConfig[] {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (err) {
    logError(err)
    debugLogger.warn('AGENT_LOADER_FLAG_AGENTS_JSON_PARSE_FAILED', {
      error: err instanceof Error ? err.message : String(err),
    })
    return []
  }

  const parsed = agentsJsonSchema.safeParse(raw)
  if (!parsed.success) {
    logError(parsed.error)
    debugLogger.warn('AGENT_LOADER_FLAG_AGENTS_SCHEMA_INVALID', {
      error: parsed.error.message,
    })
    return []
  }

  return Object.entries(parsed.data)
    .map(([agentType, value]) => parseAgentFromJson(agentType, value))
    .filter((agent): agent is AgentConfig => agent !== null)
}
