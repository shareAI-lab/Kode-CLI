import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { Command } from '../types'

import {
  createPullRequestWatcherCommands,
  createWorkflowRunWatchCommand,
  isReadOnlyGhCommand,
  type ReadOnlyGhCommand,
} from '#core/integrations/github'
import { redactSensitiveMemoryText } from '#core/memory'

const execFileAsync = promisify(execFile)
const MAX_COMMAND_OUTPUT_CHARS = 2_400
const MAX_RENDERED_OUTPUT_CHARS = 7_200
const GH_TIMEOUT_MS = 15_000

type WatchTarget =
  | { kind: 'pr'; owner: string; repo: string; number: number }
  | { kind: 'run'; owner: string; repo: string; runId: number }

type GhExecutionResult = {
  stdout?: string
  stderr?: string
  exitCode: number | null
}

type GhWatchExecutor = (
  command: ReadOnlyGhCommand,
  options: { signal: AbortSignal },
) => Promise<GhExecutionResult>

let ghWatchExecutorForTests: GhWatchExecutor | null = null

export function __setGhWatchExecutorForTests(
  executor: GhWatchExecutor | null,
): void {
  ghWatchExecutorForTests = executor
}

function usage(message?: string): string {
  return [
    ...(message ? [message, ''] : []),
    'Usage:',
    '  /watch pr <owner>/<repo>#<number>',
    '  /watch run <owner>/<repo>#<run-id>',
    '',
    'Runs only bounded, read-only gh probes. It never comments, merges, reruns, or changes GitHub state.',
  ].join('\n')
}

export function parseWatchTarget(
  args: string,
): WatchTarget | { error: string } {
  const parts = args.trim().split(/\s+/u).filter(Boolean)
  if (parts.length !== 2) return { error: usage() }
  const [kind, reference] = parts
  if (kind !== 'pr' && kind !== 'run')
    return { error: usage('Unknown watch target.') }

  const match = reference!.match(
    /^([A-Za-z0-9][A-Za-z0-9_.-]{0,99})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})#([1-9]\d*)$/u,
  )
  if (!match)
    return { error: usage('Target must be owner/repo#positive-number.') }
  const [, owner, repo, rawNumber] = match
  const number = Number(rawNumber)
  if (!Number.isSafeInteger(number) || number <= 0) {
    return { error: usage('Target number must be a positive integer.') }
  }
  return kind === 'pr'
    ? { kind, owner: owner!, repo: repo!, number }
    : { kind, owner: owner!, repo: repo!, runId: number }
}

function stringFromUnknown(value: unknown): string {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return ''
}

async function defaultGhWatchExecutor(
  command: ReadOnlyGhCommand,
  options: { signal: AbortSignal },
): Promise<GhExecutionResult> {
  try {
    const result = await execFileAsync('gh', [...command.args], {
      windowsHide: true,
      timeout: GH_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
      signal: options.signal,
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: '1',
        GIT_TERMINAL_PROMPT: '0',
        NO_COLOR: '1',
      },
    })
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 }
  } catch (error) {
    const record = error as {
      code?: unknown
      stdout?: unknown
      stderr?: unknown
    }
    return {
      stdout: stringFromUnknown(record.stdout),
      stderr: stringFromUnknown(record.stderr),
      exitCode: typeof record.code === 'number' ? record.code : null,
    }
  }
}

function restrictOutput(
  value: string | undefined,
  maxChars = MAX_COMMAND_OUTPUT_CHARS,
): string {
  const safe = redactSensitiveMemoryText(String(value ?? ''))
    .text.replace(/\u0000/g, '')
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
  if (safe.length <= maxChars) return safe
  return `${safe.slice(0, maxChars)}\n… output truncated`
}

function commandLabel(command: ReadOnlyGhCommand): string {
  switch (command.purpose) {
    case 'pull_request':
      return 'Pull request'
    case 'checks':
      return 'CI checks'
    case 'reviews':
      return 'Reviews'
    case 'workflow_run':
      return 'Workflow run'
  }
}

async function executeReadOnlyGhCommand(
  command: ReadOnlyGhCommand,
  signal: AbortSignal,
): Promise<GhExecutionResult> {
  if (!isReadOnlyGhCommand(command)) {
    throw new Error('Refused to execute a non-read-only GitHub command.')
  }
  const executor = ghWatchExecutorForTests ?? defaultGhWatchExecutor
  return await executor(command, { signal })
}

function renderWatchOutput(
  title: string,
  entries: Array<{ command: ReadOnlyGhCommand; result: GhExecutionResult }>,
): string {
  const lines = [`Read-only GitHub watch: ${title}`]
  for (const { command, result } of entries) {
    const output = restrictOutput(result.stdout || result.stderr)
    const status = result.exitCode === 0 ? 'ok' : 'unavailable/failed'
    lines.push('', `## ${commandLabel(command)} (${status})`)
    lines.push(output || 'No output returned.')
  }
  const rendered = lines.join('\n')
  return rendered.length <= MAX_RENDERED_OUTPUT_CHARS
    ? rendered
    : `${rendered.slice(0, MAX_RENDERED_OUTPUT_CHARS)}\n… watch output truncated`
}

const watch = {
  type: 'local',
  name: 'watch',
  description: 'Run bounded read-only GitHub PR or workflow probes',
  argumentHint: '<pr|run> <owner>/<repo>#<number>',
  isEnabled: true,
  isHidden: true,
  disableNonInteractive: true,
  async call(args: string, context: { abortController: AbortController }) {
    const target = parseWatchTarget(args)
    if ('error' in target) return target.error

    const commands =
      target.kind === 'pr'
        ? createPullRequestWatcherCommands(target)
        : [createWorkflowRunWatchCommand(target)]
    try {
      const entries = []
      for (const command of commands) {
        if (context.abortController.signal.aborted) {
          return 'GitHub watch cancelled.'
        }
        entries.push({
          command,
          result: await executeReadOnlyGhCommand(
            command,
            context.abortController.signal,
          ),
        })
      }
      const title =
        target.kind === 'pr'
          ? `PR ${target.owner}/${target.repo}#${target.number}`
          : `run ${target.owner}/${target.repo}#${target.runId}`
      return renderWatchOutput(title, entries)
    } catch (error) {
      const message = restrictOutput(
        error instanceof Error ? error.message : String(error),
        400,
      )
      return `GitHub watch could not start: ${message || 'unknown error'}`
    }
  },
  userFacingName() {
    return 'watch'
  },
} satisfies Command

export default watch
