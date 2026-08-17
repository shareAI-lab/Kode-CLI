import { existsSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { getModelManager } from '#core/utils/model'
import { resolveToolNameAlias } from '#core/utils/toolNameAliases'
import {
  defaultValidationPaths,
  listMarkdownFilesRecursively,
} from './agentsValidatePaths'
import { readMarkdownFile } from './agentsValidateMarkdown'

export type AgentValidateIssue = {
  level: 'error' | 'warning'
  message: string
}

export type AgentValidateFileResult = {
  filePath: string
  agentType: string | null
  issues: AgentValidateIssue[]
  model?: string
  normalizedModel?: string
}

const VALID_PERMISSION_MODES = new Set([
  'acceptEdits',
  'cautious',
  'plan',
  'yolo',
  'default',
  'bypassPermissions',
  'dontAsk',
  'delegate',
])

const SUBAGENT_HARD_BLOCKED_TOOLS = new Set<string>([
  'Task',
  'TaskOutput',
  'TaskStop',
  'EnterPlanMode',
  'ExitPlanMode',
  'AskUserQuestion',
])

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

// moved: path scanning and markdown parsing helpers

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
        case ' ': {
          if (inParens) {
            current += ch
            break
          }
          const trimmed = current.trim()
          if (trimmed) out.push(trimmed)
          current = ''
          break
        }
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

function toolNameFromSpec(spec: string): string {
  const trimmed = spec.trim()
  if (!trimmed) return trimmed
  const match = trimmed.match(/^([^(]+)\(([^)]+)\)$/)
  if (!match) return trimmed
  const toolName = match[1]?.trim()
  return toolName || trimmed
}

function mapLegacyModelToKodePointer(model: string): string | 'inherit' {
  if (model === 'inherit') return 'inherit'
  if (model === 'opus') return 'main'
  if (model === 'sonnet') return 'task'
  if (model === 'haiku') return 'quick'
  return model
}

function validateOneAgentFile(args: {
  filePath: string
  knownToolNames?: Set<string>
}): AgentValidateFileResult {
  const issues: AgentValidateIssue[] = []
  const read = readMarkdownFile(args.filePath)
  if ('error' in read) {
    issues.push({
      level: 'error',
      message: `Failed to parse file: ${read.error}`,
    })
    return { filePath: args.filePath, agentType: null, issues }
  }

  const fm = read.frontmatter
  const agentType = normalizeString(fm.name)
  const description = normalizeString(fm.description)

  if (!agentType) {
    issues.push({
      level: 'error',
      message: `Missing required frontmatter field 'name'`,
    })
  }
  if (!description) {
    issues.push({
      level: 'error',
      message: `Missing required frontmatter field 'description'`,
    })
  }

  const toolsList = z2A(fm.tools)
  const tools = toolsList === undefined ? '*' : toolsList
  if (Array.isArray(tools) && tools.length === 0) {
    issues.push({ level: 'warning', message: `No tools selected (tools: [])` })
  }

  const disallowedRaw =
    fm.disallowedTools ?? fm['disallowed-tools'] ?? fm['disallowed_tools']
  const disallowed =
    disallowedRaw !== undefined ? z2A(disallowedRaw) : undefined
  if (disallowedRaw !== undefined && disallowed === undefined) {
    issues.push({
      level: 'warning',
      message: `disallowedTools contains '*' and will be ignored (compatibility behavior)`,
    })
  }

  if (Array.isArray(tools)) {
    for (const spec of tools) {
      const toolName = toolNameFromSpec(spec)
      const resolution = resolveToolNameAlias(toolName)
      const effectiveName = resolution.resolvedName

      if (SUBAGENT_HARD_BLOCKED_TOOLS.has(effectiveName)) {
        issues.push({
          level: 'warning',
          message: `Tool '${toolName}' is not available to subagents and will be ignored`,
        })
      }
      if (
        args.knownToolNames &&
        effectiveName &&
        !args.knownToolNames.has(effectiveName)
      ) {
        issues.push({
          level: 'warning',
          message: resolution.wasAliased
            ? `Unknown tool '${toolName}' (alias of '${effectiveName}', from '${spec}')`
            : `Unknown tool '${toolName}' (from '${spec}')`,
        })
      }
    }
  }

  const permissionMode = normalizeString(fm.permissionMode)
  if (permissionMode && !VALID_PERMISSION_MODES.has(permissionMode)) {
    issues.push({
      level: 'error',
      message: `Invalid permissionMode '${permissionMode}' (expected: ${Array.from(VALID_PERMISSION_MODES).join(', ')})`,
    })
  }

  const forkContextValue: unknown = fm.forkContext
  if (
    forkContextValue !== undefined &&
    forkContextValue !== 'true' &&
    forkContextValue !== 'false'
  ) {
    issues.push({
      level: 'error',
      message: `Invalid forkContext value '${String(forkContextValue)}' (must be the string 'true' or 'false')`,
    })
  }
  const forkContext = forkContextValue === 'true'

  let modelRaw: unknown = fm.model
  if (typeof modelRaw !== 'string' && typeof fm.model_name === 'string') {
    modelRaw = fm.model_name
  }
  const model = typeof modelRaw === 'string' ? modelRaw.trim() : undefined

  if (forkContext && model && model !== 'inherit') {
    issues.push({
      level: 'warning',
      message: `forkContext is true, so model will be forced to 'inherit' (compatibility behavior)`,
    })
  }

  const normalizedModel =
    model && model.length > 0 ? mapLegacyModelToKodePointer(model) : undefined

  if (normalizedModel && normalizedModel !== 'inherit') {
    const manager = getModelManager()
    const resolved = manager.resolveModelWithInfo(normalizedModel)
    if (!resolved.success || !resolved.profile) {
      issues.push({
        level: 'error',
        message:
          resolved.error ??
          `Model '${String(normalizedModel)}' could not be resolved`,
      })
    }
  }

  const filename = basename(args.filePath, '.md')
  if (agentType && filename !== agentType) {
    issues.push({
      level: 'warning',
      message: `Filename '${filename}.md' does not match agent name '${agentType}'`,
    })
  }

  return {
    filePath: args.filePath,
    agentType: agentType ?? null,
    issues,
    ...(model ? { model } : {}),
    ...(normalizedModel ? { normalizedModel } : {}),
  }
}

export async function validateAgentTemplates(args: {
  cwd: string
  paths: string[]
  checkTools: boolean
}): Promise<{
  ok: boolean
  errorCount: number
  warningCount: number
  results: AgentValidateFileResult[]
}> {
  const inputPaths =
    args.paths.length > 0 ? args.paths : defaultValidationPaths(args.cwd)
  const markdownFiles = new Set<string>()
  for (const inputPath of inputPaths) {
    const resolved = resolve(args.cwd, inputPath)
    if (!existsSync(resolved)) continue
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(resolved)
    } catch {
      continue
    }
    if (st.isFile()) {
      if (resolved.toLowerCase().endsWith('.md')) markdownFiles.add(resolved)
      continue
    }
    if (st.isDirectory()) {
      for (const f of listMarkdownFilesRecursively(resolved))
        markdownFiles.add(f)
    }
  }

  let knownToolNames: Set<string> | undefined
  if (args.checkTools) {
    try {
      const { getTools } = await import('#tools')
      const { getCurrentProjectConfig } = await import('#core/utils/config')
      const allTools = await getTools(
        getCurrentProjectConfig().enableArchitectTool,
      )
      knownToolNames = new Set(allTools.map(t => t.name))
    } catch {
      knownToolNames = undefined
    }
  }

  const results = Array.from(markdownFiles)
    .sort((a, b) => a.localeCompare(b))
    .map(filePath =>
      validateOneAgentFile({
        filePath,
        knownToolNames,
      }),
    )

  const errorCount = results.reduce(
    (sum, r) => sum + r.issues.filter(i => i.level === 'error').length,
    0,
  )
  const warningCount = results.reduce(
    (sum, r) => sum + r.issues.filter(i => i.level === 'warning').length,
    0,
  )

  return { ok: errorCount === 0, errorCount, warningCount, results }
}
