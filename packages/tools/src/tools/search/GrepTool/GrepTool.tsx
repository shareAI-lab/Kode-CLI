import { Box, Text } from 'ink'
import React from 'react'
import { existsSync } from 'fs'
import { z } from 'zod'
import { Tool } from '@kode/tool-interface/Tool'
import { getCwd } from '#core/utils/state'
import { getAbsoluteAndRelativePaths, getAbsolutePath } from '#core/utils/file'
import { DESCRIPTION, TOOL_NAME_FOR_PROMPT } from './prompt'
import { hasReadPermission } from '#core/utils/permissions/filesystem'
import { relative } from 'path'
import { formatPagination, truncateToCharBudget } from './helpers'
import type { GrepToolOutput } from './types'
import { runGrepTool } from './execute'

const inputSchema = z.strictObject({
  pattern: z
    .string()
    .describe('The regular expression pattern to search for in file contents'),
  path: z
    .string()
    .optional()
    .describe(
      'File or directory to search in (rg PATH). Defaults to current working directory.',
    ),
  glob: z
    .string()
    .optional()
    .describe(
      'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob',
    ),
  output_mode: z
    .enum(['content', 'files_with_matches', 'count'])
    .optional()
    .describe(
      'Output mode: "content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), "files_with_matches" shows file paths (supports head_limit), "count" shows match counts (supports head_limit). Defaults to "files_with_matches".',
    ),
  '-B': z
    .number()
    .optional()
    .describe(
      'Number of lines to show before each match (rg -B). Requires output_mode: "content", ignored otherwise.',
    ),
  '-A': z
    .number()
    .optional()
    .describe(
      'Number of lines to show after each match (rg -A). Requires output_mode: "content", ignored otherwise.',
    ),
  '-C': z
    .number()
    .optional()
    .describe(
      'Number of lines to show before and after each match (rg -C). Requires output_mode: "content", ignored otherwise.',
    ),
  '-n': z
    .boolean()
    .optional()
    .describe(
      'Show line numbers in output (rg -n). Requires output_mode: "content", ignored otherwise. Defaults to true.',
    ),
  '-i': z.boolean().optional().describe('Case insensitive search (rg -i)'),
  type: z
    .string()
    .optional()
    .describe(
      'File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types.',
    ),
  head_limit: z
    .number()
    .optional()
    .describe(
      'Limit output to first N lines/entries, equivalent to "| head -N". Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count (limits count entries). Defaults based on "cap" experiment value: 0 (unlimited), 20, or 100.',
    ),
  offset: z
    .number()
    .optional()
    .describe(
      'Skip first N lines/entries before applying head_limit, equivalent to "| tail -n +N | head -N". Works across all output modes. Defaults to 0.',
    ),
  multiline: z
    .boolean()
    .optional()
    .describe(
      'Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.',
    ),
})

type Input = typeof inputSchema
type Output = GrepToolOutput

export const GrepTool = {
  name: TOOL_NAME_FOR_PROMPT,
  async description() {
    return DESCRIPTION
  },
  userFacingName() {
    return 'Search'
  },
  inputSchema,
  readModeAccess: 'always',
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true // GrepTool is read-only, safe for concurrent execution
  },
  async isEnabled() {
    return true
  },
  needsPermissions(input) {
    return !hasReadPermission(input?.path || getCwd())
  },
  async prompt() {
    return DESCRIPTION
  },
  renderToolUseMessage(input: any, { verbose }: { verbose: boolean }) {
    const {
      pattern,
      path,
      glob,
      type,
      output_mode = 'files_with_matches',
      head_limit,
    } = input
    if (!pattern) return ''
    const parts = [`pattern: "${pattern}"`]
    if (path) {
      const { absolutePath, relativePath } = getAbsoluteAndRelativePaths(path)
      parts.push(`path: "${verbose ? absolutePath : relativePath}"`)
    }
    if (glob) parts.push(`glob: "${glob}"`)
    if (type) parts.push(`type: "${type}"`)
    if (output_mode !== 'files_with_matches') {
      parts.push(`output_mode: "${output_mode}"`)
    }
    if (head_limit !== undefined) parts.push(`head_limit: ${head_limit}`)
    return parts.join(', ')
  },
  renderToolUseRejectedMessage() {
    return null
  },
  renderToolResultMessage(output) {
    // Handle string content for backward compatibility
    if (typeof output === 'string') {
      // Convert string to Output type using tmpDeserializeOldLogResult if needed
      output = output as unknown as Output
    }

    return (
      <Box flexDirection="row">
        <Text>&nbsp;&nbsp;⎿ &nbsp;Found </Text>
        <Text bold>
          {output.mode === 'content'
            ? (output.numLines ?? 0)
            : output.mode === 'count'
              ? (output.numMatches ?? 0)
              : output.numFiles}{' '}
        </Text>
        <Text>
          {output.mode === 'content'
            ? (output.numLines ?? 0) === 1
              ? 'line'
              : 'lines'
            : output.mode === 'count'
              ? (output.numMatches ?? 0) === 1
                ? 'match'
                : 'matches'
              : output.numFiles === 1
                ? 'file'
                : 'files'}
        </Text>
      </Box>
    )
  },
  renderResultForAssistant(result: Output) {
    const pagination = formatPagination(
      result.appliedLimit,
      result.appliedOffset,
    )

    if (result.mode === 'content') {
      const base = truncateToCharBudget(result.content || 'No matches found')
      return pagination
        ? `${base}\n\n[Showing results with pagination = ${pagination}]`
        : base
    }

    if (result.mode === 'count') {
      const base = truncateToCharBudget(result.content || 'No matches found')
      const numMatches = result.numMatches ?? 0
      const numFiles = result.numFiles ?? 0
      return (
        base +
        `\n\nFound ${numMatches} total ${numMatches === 1 ? 'occurrence' : 'occurrences'} across ${numFiles} ${numFiles === 1 ? 'file' : 'files'}.` +
        (pagination ? ` with pagination = ${pagination}` : '')
      )
    }

    // files_with_matches
    if (result.numFiles === 0) return 'No files found'
    const header = `Found ${result.numFiles} file${result.numFiles === 1 ? '' : 's'}${pagination ? ` ${pagination}` : ''}\n${result.filenames.join('\n')}`
    return truncateToCharBudget(header)
  },
  async validateInput({ path }: any) {
    if (path) {
      const abs = getAbsolutePath(path)
      if (!abs || !existsSync(abs)) {
        return {
          result: false,
          message: `Path does not exist: ${path}`,
          errorCode: 1,
        }
      }
    }
    return { result: true }
  },
  async *call(input: any, toolUseContext: any) {
    const output = await runGrepTool({ input, toolUseContext })
    yield {
      type: 'result',
      data: output,
      resultForAssistant: this.renderResultForAssistant(output),
    }
  },
} satisfies Tool<Input, Output>
