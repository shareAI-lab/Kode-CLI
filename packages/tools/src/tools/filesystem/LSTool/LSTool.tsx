import { z } from 'zod'
import { Tool } from '@kode/tool-interface/Tool'
import { getCwd } from '#core/utils/state'
import { readdir } from 'fs/promises'
import { existsSync, statSync } from 'fs'
import { isAbsolute, relative, resolve } from 'path'
import { hasReadPermission } from '#core/utils/permissions/filesystem'
import { DESCRIPTION, TOOL_NAME_FOR_PROMPT } from './prompt'

const inputSchema = z.strictObject({
  path: z
    .string()
    .optional()
    .describe(
      'Directory path to list. If omitted, uses the current working directory.',
    ),
  all: z
    .boolean()
    .optional()
    .describe('Include dotfiles (equivalent to ls -a).'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .optional()
    .describe('Maximum number of entries to return (default: 200).'),
})

type Output = {
  path: string
  entries: string[]
  total: number
  truncated: boolean
}

const DEFAULT_LIMIT = 200

function resolveDirPath(path: string | undefined): string {
  if (!path) return getCwd()
  return isAbsolute(path) ? resolve(path) : resolve(getCwd(), path)
}

function renderResultForAssistant(output: Output): string {
  if (output.entries.length === 0) return 'No entries found'
  const suffix = output.truncated
    ? `\n(Results are truncated. Showing ${output.entries.length}/${output.total}.)`
    : ''
  return `${output.entries.join('\n')}${suffix}`
}

export const LSTool = {
  name: TOOL_NAME_FOR_PROMPT,
  async description() {
    return DESCRIPTION
  },
  inputSchema,
  readModeAccess: 'always',
  async isEnabled() {
    return true
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  needsPermissions(input) {
    return !hasReadPermission(resolveDirPath(input?.path))
  },
  async prompt() {
    return DESCRIPTION
  },
  async validateInput({ path }) {
    const dir = resolveDirPath(path)
    if (!existsSync(dir)) {
      return {
        result: false,
        message: `Directory does not exist: ${path ?? dir}`,
        errorCode: 1,
      }
    }
    if (!statSync(dir).isDirectory()) {
      return {
        result: false,
        message: `Path is not a directory: ${path ?? dir}`,
        errorCode: 2,
      }
    }
    return { result: true }
  },
  renderToolUseMessage({ path, all, limit }, { verbose }) {
    const absolute = resolveDirPath(path)
    const display =
      verbose || !path ? absolute : relative(getCwd(), absolute) || '.'
    const flags: string[] = []
    if (all) flags.push('all')
    if (limit !== undefined) flags.push(`limit=${limit}`)
    return `path: "${display}"${flags.length > 0 ? ` (${flags.join(', ')})` : ''}`
  },
  async *call(
    { path, all, limit },
    { abortController },
  ): AsyncGenerator<
    { type: 'result'; resultForAssistant: string; data: Output },
    void
  > {
    const dir = resolveDirPath(path)
    const includeHidden = all === true
    const max = limit ?? DEFAULT_LIMIT

    if (abortController.signal.aborted) {
      const output: Output = {
        path: dir,
        entries: [],
        total: 0,
        truncated: false,
      }
      yield {
        type: 'result',
        resultForAssistant: renderResultForAssistant(output),
        data: output,
      }
      return
    }

    const dirents = await readdir(dir, { withFileTypes: true })
    const entries = dirents
      .filter(d => includeHidden || !d.name.startsWith('.'))
      .map(d => {
        if (d.isDirectory()) return `${d.name}/`
        if (d.isSymbolicLink()) return `${d.name}@`
        return d.name
      })
      .sort((a, b) => a.localeCompare(b))

    const truncated = entries.length > max
    const limited = entries.slice(0, max)

    const output: Output = {
      path: dir,
      entries: limited,
      total: entries.length,
      truncated,
    }

    yield {
      type: 'result',
      resultForAssistant: renderResultForAssistant(output),
      data: output,
    }
  },
  renderResultForAssistant,
} satisfies Tool<typeof inputSchema, Output>
