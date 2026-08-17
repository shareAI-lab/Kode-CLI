import { createHash } from 'node:crypto'

export type VerificationKind = 'test' | 'typecheck' | 'lint' | 'build' | 'check'

export type VerificationStatus =
  'passed' | 'failed' | 'blocked' | 'interrupted' | 'started'

export type VerificationReceipt = {
  version: 1
  kind: VerificationKind
  status: VerificationStatus
  toolUseId: string
  commandDigest: string
  outputDigest: string
  recordedAt: string
}

type BashOutput = {
  stdout?: unknown
  stderr?: unknown
  interrupted?: unknown
  backgroundTaskId?: unknown
  bashId?: unknown
  returnCodeInterpretation?: unknown
}

type TaskOutputResult = {
  retrieval_status?: unknown
  task?: {
    task_type?: unknown
    status?: unknown
    command?: unknown
    output?: unknown
    error?: unknown
    exitCode?: unknown
  } | null
}

const CONTROL_OPERATOR_RE = /[;&|`$()<>\r\n]/
const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=[^\s]+$/
const INFORMATION_ONLY_FLAGS = new Set(['--help', '-h', '--version', '-v'])
const SIMPLE_CD_PREFIX_RE =
  /^cd\s+(?:"[^"$`\r\n]*"|'[^'\r\n]*'|[^\s;&|`$()<>\r\n]+)\s+&&\s+/

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function normalizeCommand(command: string): string | null {
  const trimmed = command.trim()
  if (!trimmed) return null
  const cdPrefix = trimmed.match(SIMPLE_CD_PREFIX_RE)?.[0]
  if (cdPrefix) {
    const nested = trimmed.slice(cdPrefix.length)
    if (!nested || CONTROL_OPERATOR_RE.test(nested)) return null
    return `${cdPrefix.trim()} ${nested.trim().replace(/\s+/g, ' ')}`
  }
  if (CONTROL_OPERATOR_RE.test(trimmed)) return null
  return trimmed.replace(/\s+/g, ' ')
}

function classifyScriptName(
  value: string | undefined,
): VerificationKind | null {
  if (!value) return null
  if (value === 'check' || value.startsWith('check:')) return 'check'
  if (value === 'typecheck' || value.startsWith('typecheck:')) {
    return 'typecheck'
  }
  if (value === 'lint' || value.startsWith('lint:')) return 'lint'
  if (value === 'build' || value.startsWith('build:')) return 'build'
  if (value === 'test' || value.startsWith('test:')) return 'test'
  return null
}

function classifyExecutable(
  executable: string,
  args: string[],
): VerificationKind | null {
  if (executable === 'bun' || executable === 'npm' || executable === 'pnpm') {
    if (args[0] === 'test') return 'test'
    if (args[0] === 'run') return classifyScriptName(args[1])
    if ((executable === 'bun' && args[0] === 'x') || args[0] === 'exec') {
      const nestedExecutable = args[1]
      return nestedExecutable
        ? classifyExecutable(nestedExecutable, args.slice(2))
        : null
    }
    return null
  }

  if (executable === 'yarn') {
    if (args[0] === 'test') return 'test'
    if (args[0] === 'run') return classifyScriptName(args[1])
    return classifyScriptName(args[0])
  }

  if (executable === 'npx' || executable === 'bunx') {
    const nestedExecutable = args.find(argument => !argument.startsWith('-'))
    if (!nestedExecutable) return null
    const nestedIndex = args.indexOf(nestedExecutable)
    return classifyExecutable(nestedExecutable, args.slice(nestedIndex + 1))
  }

  if (
    (executable === 'uv' || executable === 'poetry') &&
    args[0] === 'run' &&
    args[1]
  ) {
    return classifyExecutable(args[1], args.slice(2))
  }

  if (
    executable === 'vitest' ||
    executable === 'jest' ||
    executable === 'pytest' ||
    executable === 'mocha' ||
    executable === 'ava'
  ) {
    return 'test'
  }

  if (executable === 'python' || executable === 'python3') {
    if (args[0] === '-m' && args[1]) {
      return classifyExecutable(args[1], args.slice(2))
    }
    return null
  }

  if (
    executable === 'tsc' ||
    executable === 'pyright' ||
    executable === 'mypy'
  ) {
    return 'typecheck'
  }

  if (executable === 'eslint' || executable === 'golangci-lint') return 'lint'
  if (executable === 'biome' && args[0] === 'check') return 'lint'
  if (executable === 'ruff' && args[0] === 'check') return 'lint'

  if (executable === 'deno') {
    if (args[0] === 'test') return 'test'
    if (args[0] === 'check') return 'typecheck'
    if (args[0] === 'lint') return 'lint'
    return null
  }

  if (executable === 'go') {
    if (args[0] === 'test') return 'test'
    if (args[0] === 'vet') return 'typecheck'
    if (args[0] === 'build') return 'build'
    return null
  }

  if (executable === 'cargo') {
    if (args[0] === 'test') return 'test'
    if (args[0] === 'check') return 'typecheck'
    if (args[0] === 'clippy') return 'lint'
    if (args[0] === 'build') return 'build'
    return null
  }

  if (executable === 'mvn' || executable === './mvnw') {
    if (args.includes('test')) return 'test'
    if (args.includes('verify')) return 'check'
    if (args.includes('compile') || args.includes('package')) return 'build'
    return null
  }

  if (executable === 'gradle' || executable === './gradlew') {
    if (args.includes('test')) return 'test'
    if (args.includes('check')) return 'check'
    if (args.includes('build')) return 'build'
    return null
  }

  if (executable === 'dotnet') {
    if (args[0] === 'test') return 'test'
    if (args[0] === 'build') return 'build'
    return null
  }

  if (executable === 'swift') {
    if (args[0] === 'test') return 'test'
    if (args[0] === 'build') return 'build'
    return null
  }

  if (executable === 'make' || executable === 'gmake') {
    for (const argument of args) {
      const kind = classifyScriptName(argument)
      if (kind) return kind
    }
    return null
  }

  if (executable === 'just' || executable === 'task') {
    return classifyScriptName(args.find(argument => !argument.startsWith('-')))
  }

  if (executable === 'git' && args[0] === 'diff' && args.includes('--check')) {
    return 'check'
  }

  return null
}

export function classifyVerificationCommand(
  command: string,
): VerificationKind | null {
  const normalized = normalizeCommand(command)
  if (!normalized) return null

  const commandWithoutCwd = normalized.match(SIMPLE_CD_PREFIX_RE)
    ? normalized.replace(SIMPLE_CD_PREFIX_RE, '')
    : normalized
  const parts = commandWithoutCwd.split(' ')
  let index = 0
  if (parts[index] === 'env') index += 1
  while (index < parts.length && ENV_ASSIGNMENT_RE.test(parts[index]!)) {
    index += 1
  }

  const executable = parts[index]
  const args = parts.slice(index + 1)
  if (!executable) return null
  if (args.some(argument => INFORMATION_ONLY_FLAGS.has(argument))) return null
  return classifyExecutable(executable, args)
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function classifyVerificationStatus(output: BashOutput): VerificationStatus {
  if (output.backgroundTaskId || output.bashId) return 'started'
  if (output.interrupted === true) return 'interrupted'

  const stderr = readString(output.stderr)
  const interpretation = readString(output.returnCodeInterpretation)
  const diagnostic = `${stderr}\n${interpretation}`
  if (/\bExit code\s+[1-9]\d*\b/i.test(diagnostic)) return 'failed'
  if (
    /(?:^|\n)(?:Blocked:|This command must run|Command failed:|Command cancelled)/i.test(
      diagnostic,
    )
  ) {
    return 'blocked'
  }
  return 'passed'
}

function classifyBackgroundVerificationStatus(
  task: NonNullable<TaskOutputResult['task']>,
): VerificationStatus {
  if (task.status === 'running' || task.status === 'pending') return 'started'
  if (task.status === 'killed') return 'interrupted'
  if (
    task.status === 'failed' ||
    (typeof task.exitCode === 'number' && task.exitCode !== 0)
  ) {
    return 'failed'
  }
  return task.status === 'completed' ? 'passed' : 'blocked'
}

export function createVerificationReceipt(args: {
  toolName: string
  isTrustedExecutionTool: boolean
  toolUseId: string
  input: Record<string, unknown>
  output: unknown
  now?: Date
}): VerificationReceipt | null {
  if (!args.isTrustedExecutionTool) return null

  if (args.toolName === 'TaskOutput') {
    if (!args.output || typeof args.output !== 'object') return null
    const task = (args.output as TaskOutputResult).task
    if (
      !task ||
      task.task_type !== 'local_bash' ||
      typeof task.command !== 'string'
    ) {
      return null
    }
    const normalized = normalizeCommand(task.command)
    const kind = normalized ? classifyVerificationCommand(normalized) : null
    if (!normalized || !kind) return null
    const outputMaterial = [
      readString(task.output),
      readString(task.error),
      typeof task.exitCode === 'number' ? String(task.exitCode) : '',
    ].join('\u0000')
    return {
      version: 1,
      kind,
      status: classifyBackgroundVerificationStatus(task),
      toolUseId: args.toolUseId,
      commandDigest: digest(normalized),
      outputDigest: digest(outputMaterial),
      recordedAt: (args.now ?? new Date()).toISOString(),
    }
  }

  if (args.toolName !== 'Bash') return null
  const command = args.input.command
  if (typeof command !== 'string') return null
  const normalized = normalizeCommand(command)
  const kind = normalized ? classifyVerificationCommand(normalized) : null
  if (!normalized || !kind || !args.output || typeof args.output !== 'object') {
    return null
  }

  const output = args.output as BashOutput
  const outputMaterial = [
    readString(output.stdout),
    readString(output.stderr),
    readString(output.returnCodeInterpretation),
  ].join('\u0000')

  return {
    version: 1,
    kind,
    status: classifyVerificationStatus(output),
    toolUseId: args.toolUseId,
    commandDigest: digest(normalized),
    outputDigest: digest(outputMaterial),
    recordedAt: (args.now ?? new Date()).toISOString(),
  }
}

export function attachVerificationReceipt<T>(
  output: T,
  receipt: VerificationReceipt | null,
): T {
  if (
    !receipt ||
    !output ||
    typeof output !== 'object' ||
    Array.isArray(output)
  ) {
    return output
  }
  return { ...(output as Record<string, unknown>), verification: receipt } as T
}

export function formatVerificationSystemMessage(
  receipt: VerificationReceipt,
): string {
  return [
    '# Verification receipt (engine generated)',
    `The exact ${receipt.kind} command completed with status ${receipt.status} at ${receipt.recordedAt}.`,
    `Command digest: ${receipt.commandDigest}; output digest: ${receipt.outputDigest}.`,
    'This proves only the recorded command outcome. It does not prove coverage of later edits, unselected tests, deployment, or external side effects.',
    receipt.status === 'passed'
      ? 'You may report this exact command as passed only if no relevant code changed after it; otherwise run an applicable verification again.'
      : 'Do not report this verification as passed. Explain the recorded state and continue with an appropriate safe next step.',
  ].join('\n')
}
