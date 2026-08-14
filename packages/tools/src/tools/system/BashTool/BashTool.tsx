import { EOL } from 'os'
import { isAbsolute, relative, resolve } from 'path'
import * as React from 'react'
import { z } from 'zod'
import { PRODUCT_NAME } from '#core/constants/product'
import { LEGACY_ENV } from '#core/compat/legacyEnv'
import {
  Tool,
  ValidationResult,
  ToolUseContext,
} from '@kode/tool-interface/Tool'
import { splitCommand } from '#core/utils/commands'
import { isInDirectory } from '#core/utils/file'
import { getBunShellSandboxPlan } from '#core/sandbox/bunShellSandboxPlan'
import { getCwd, getOriginalCwd } from '#core/utils/state'
import { isBashCommandReadOnly } from '@kode/permissions/bash'
import { getBackgroundTaskOutputFilePath } from '#core/tasks/backgroundRegistry'
import BashToolResultMessage from './BashToolResultMessage'
import { DEFAULT_TIMEOUT_MS, getBashToolPrompt } from './prompt'
import { formatDuration } from './text'
import { callBashTool } from './call'

export const inputSchema = z.object({
  command: z.string().describe('The command to execute'),
  timeout: z
    .number()
    .optional()
    .describe('Optional timeout in milliseconds (max 600000)'),
  description: z
    .string()
    .optional()
    .describe(
      `Clear, concise description of what this command does in 5-10 words, in active voice. Examples:
Input: ls
Output: List files in current directory

Input: git status
Output: Show working tree status

Input: npm install
Output: Install package dependencies

Input: mkdir foo
Output: Create directory 'foo'`,
    ),
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      'Set to true to run this command in the background. Use TaskOutput to read the output later.',
    ),
  dangerouslyDisableSandbox: z
    .boolean()
    .optional()
    .describe(
      'Set this to true to dangerously override sandbox mode and run commands without sandboxing.',
    ),
  _simulatedSedEdit: z
    .object({
      filePath: z.string(),
      newContent: z.string(),
    })
    .optional()
    .describe('Internal: pre-computed sed edit result from preview'),
})

const readModeInputSchema = inputSchema
  .pick({
    command: true,
    timeout: true,
    description: true,
  })
  .strict()

type In = typeof inputSchema
export type Out = {
  stdout: string
  stdoutLines: number // Total number of lines in original stdout, even if `stdout` is now truncated
  stderr: string
  stderrLines: number // Total number of lines in original stderr, even if `stderr` is now truncated
  summary?: string
  rawOutputPath?: string
  interrupted: boolean
  isImage?: boolean
  structuredContent?: unknown[]
  dangerouslyDisableSandbox?: boolean
  returnCodeInterpretation?: string
  bashId?: string
  backgroundTaskId?: string
}

export const BashTool = {
  name: 'Bash',
  isTrustedExecutionTool: true,
  cachedDescription: 'Run shell command',
  async description(input?: z.infer<typeof inputSchema>) {
    return input?.description || 'Run shell command'
  },
  async prompt() {
    return getBashToolPrompt()
  },
  readModeAccess: 'conditional',
  readModeInputSchema,
  isReadOnly(input?: z.infer<typeof inputSchema>) {
    if (!input || typeof input.command !== 'string') return false
    return isBashCommandReadOnly(input.command)
  },
  isConcurrencySafe(input?: z.infer<typeof inputSchema>) {
    // Compatibility: isConcurrencySafe(input) === isReadOnly(input)
    return this.isReadOnly(input)
  },
  inputSchema,
  userFacingName(input?: z.infer<typeof inputSchema>) {
    if (!input) return 'Bash'

    const raw =
      process.env.KODE_BASH_SANDBOX_SHOW_INDICATOR ??
      process.env[LEGACY_ENV.codeBashSandboxShowIndicator]
    // Compatibility: only explicit truthy values enable the indicator.
    const showIndicator = raw
      ? ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase())
      : false
    if (!showIndicator) return 'Bash'

    const plan = getBunShellSandboxPlan({
      command: input.command,
      dangerouslyDisableSandbox: input.dangerouslyDisableSandbox === true,
    })
    return plan.willSandbox ? 'SandboxedBash' : 'Bash'
  },
  async isEnabled() {
    return true
  },
  needsPermissions(): boolean {
    // Always check per-project permissions for BashTool
    return true
  },
  async validateInput(
    { command, timeout, dangerouslyDisableSandbox },
    context?: ToolUseContext,
  ): Promise<ValidationResult> {
    if (timeout !== undefined) {
      if (!Number.isFinite(timeout) || timeout < 0) {
        return {
          result: false,
          message: `Invalid timeout: ${timeout}. Timeout must be a non-negative number of milliseconds.`,
        }
      }
      if (timeout > 600_000) {
        return {
          result: false,
          message: `Invalid timeout: ${timeout}. Maximum allowed timeout is 600000ms.`,
        }
      }
    }

    const source = context?.commandSource ?? 'agent_call'
    const isUserMode = source === 'user_bash_mode'
    const safeMode = Boolean(context?.safeMode ?? context?.options?.safeMode)

    if (
      dangerouslyDisableSandbox === true &&
      safeMode &&
      source === 'agent_call'
    ) {
      return {
        result: false,
        message: 'Sandbox cannot be disabled while safe mode is enabled.',
      }
    }
    const commands = splitCommand(command)

    for (const cmd of commands) {
      const parts = cmd.split(' ')
      const baseCmd = parts[0]

      // Special handling for cd command
      if (baseCmd === 'cd' && parts[1]) {
        // In user bash mode, allow cd to any directory
        if (isUserMode) {
          continue
        }

        // In agent mode, restrict cd to child directories of original working directory
        const targetDir = parts[1]!.replace(/^['"]|['"]$/g, '') // Remove quotes if present
        const fullTargetDir = isAbsolute(targetDir)
          ? targetDir
          : resolve(getCwd(), targetDir)
        if (
          !isInDirectory(
            relative(getOriginalCwd(), fullTargetDir),
            relative(getCwd(), getOriginalCwd()),
          )
        ) {
          return {
            result: false,
            message: `ERROR: cd to '${fullTargetDir}' was blocked. For security, ${PRODUCT_NAME} may only change directories to child directories of the original working directory (${getOriginalCwd()}) for this session.`,
          }
        }
      }
    }

    return { result: true }
  },
  renderToolUseMessage(
    { command, run_in_background, description, timeout },
    options?: { verbose: boolean },
  ) {
    // Optional: show the command description in verbose mode.
    const verbose = Boolean(options?.verbose)
    const trimmedDescription = (description?.trim() || '').trim()
    const effectiveTimeout = timeout ?? DEFAULT_TIMEOUT_MS
    const timeoutSuffix = ` (timeout=${formatDuration(effectiveTimeout)})`
    const bgSuffix = run_in_background ? ' [background]' : ''
    const withDescription = (base: string): string => {
      if (!verbose || !trimmedDescription) return base
      const maxLen = 160
      const shown =
        trimmedDescription.length > maxLen
          ? `${trimmedDescription.slice(0, maxLen - 1)}…`
          : trimmedDescription
      return `${base} — ${shown}`
    }

    // Clean up any command that uses the quoted HEREDOC pattern
    if (command.includes("\"$(cat <<'EOF'")) {
      const match = command.match(
        /^(.*?)"?\$\(cat <<'EOF'\n([\s\S]*?)\n\s*EOF\n\s*\)"(.*)$/,
      )
      if (match && match[1] && match[2]) {
        const prefix = match[1]
        const content = match[2]
        const suffix = match[3] || ''
        const cleaned = `${prefix.trim()} "${content.trim()}"${suffix.trim()}`
        const base = `${cleaned}${bgSuffix}${timeoutSuffix}`
        return withDescription(base.trim())
      }
    }

    const base = `${command}${bgSuffix}${timeoutSuffix}`
    return withDescription(base.trim())
  },
  renderToolUseRejectedMessage() {
    return null
  },

  renderToolResultMessage(content) {
    return <BashToolResultMessage content={content} verbose={false} />
  },
  renderResultForAssistant({
    interrupted,
    stdout,
    stderr,
    bashId,
    backgroundTaskId,
    summary,
    isImage,
    structuredContent,
  }) {
    if (Array.isArray(structuredContent) && structuredContent.length > 0) {
      return structuredContent
    }

    if (summary) {
      return summary
    }

    if (isImage) {
      const match = stdout.trim().match(/^data:([^;]+);base64,(.+)$/)
      if (match) {
        const mediaType = match[1] || 'image/jpeg'
        const data = match[2] || ''
        return [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data },
          },
        ]
      }
    }

    let trimmedStdout = stdout
    if (trimmedStdout) {
      trimmedStdout = trimmedStdout.replace(/^(\s*\n)+/, '')
      trimmedStdout = trimmedStdout.trimEnd()
    }

    let trimmedStderr = stderr.trim()
    if (interrupted) {
      if (trimmedStderr) trimmedStderr += EOL
      trimmedStderr += '<error>Command was aborted before completion</error>'
    }

    const id = backgroundTaskId ?? bashId
    const backgroundLine = id
      ? `Command running in background with ID: ${id}. Output is being written to: ${getBackgroundTaskOutputFilePath(id)}`
      : ''

    return [trimmedStdout, trimmedStderr, backgroundLine]
      .filter(Boolean)
      .join('\n')
  },
  async *call(
    {
      command,
      timeout,
      run_in_background,
      dangerouslyDisableSandbox,
      description,
    },
    context: ToolUseContext,
  ) {
    const effectiveTimeout =
      typeof timeout === 'number' ? timeout : DEFAULT_TIMEOUT_MS
    yield* callBashTool(
      {
        command,
        timeout: effectiveTimeout,
        run_in_background,
        dangerouslyDisableSandbox,
        description,
      },
      context,
      output => this.renderResultForAssistant(output),
    )
  },
} satisfies Tool<In, Out>
