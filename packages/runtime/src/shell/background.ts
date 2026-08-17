import { spawn } from 'node:child_process'
import type {
  BackgroundProcess,
  BackgroundShellCompletion,
  BackgroundShellLaunch,
  BackgroundShellStatusAttachment,
  BashNotification,
  BunShellExecOptions,
} from './types'
import type { BunShellState } from './state'
import {
  appendTaskOutput,
  flushTaskOutput,
  getTaskOutputFilePath,
  touchTaskOutputFile,
} from '../taskOutputStore'
import { buildSandboxCommand } from './sandboxCommand'
import { annotateStderrWithSandboxViolations } from './sandboxViolations'
import { startStreamReader } from './streamReaders'
import { getShellCmdForPlatform, getShellStdioForPlatform } from './shellCmd'
import { makeBackgroundTaskId } from './ids'

export function execInBackground(
  state: BunShellState,
  command: string,
  timeout?: number,
  options?: BunShellExecOptions,
): BackgroundShellLaunch {
  const DEFAULT_TIMEOUT = 120_000
  const commandTimeout = timeout ?? DEFAULT_TIMEOUT
  const abortController = new AbortController()

  const sandbox = options?.sandbox
  const executionCwd =
    (sandbox?.enabled === true && sandbox?.chdir) || options?.cwd || state.cwd
  const sandboxCmd =
    sandbox?.enabled === true
      ? buildSandboxCommand({ command, sandbox, cwd: executionCwd })
      : null

  if (sandbox?.enabled === true && sandbox?.require && !sandboxCmd) {
    throw new Error(
      'System sandbox is required but unavailable (missing bubblewrap or unsupported platform).',
    )
  }

  const cmdToRun = sandboxCmd
    ? sandboxCmd.cmd
    : getShellCmdForPlatform(process.platform, command, process.env)

  const bashId = makeBackgroundTaskId()
  const outputFile = touchTaskOutputFile(bashId)

  const childProcess = spawn(cmdToRun[0]!, cmdToRun.slice(1), {
    cwd: executionCwd,
    stdio: getShellStdioForPlatform(process.platform),
  })
  const exitPromise = new Promise<
    { kind: 'exit'; code: number | null } | { kind: 'error'; error: Error }
  >(resolve => {
    childProcess.once('exit', code => resolve({ kind: 'exit', code }))
    childProcess.once('error', error => resolve({ kind: 'error', error }))
  })
  const timeoutHandle = setTimeout(() => {
    abortController.abort()
    backgroundProcess.timedOut = true
    childProcess.kill()
  }, commandTimeout)

  const backgroundProcess: BackgroundProcess = {
    id: bashId,
    command,
    stdout: '',
    stderr: '',
    stdoutCursor: 0,
    stderrCursor: 0,
    stdoutLineCount: 0,
    stderrLineCount: 0,
    lastReportedStdoutLines: 0,
    lastReportedStderrLines: 0,
    code: null,
    interrupted: false,
    killed: false,
    timedOut: false,
    completionStatusSentInAttachment: false,
    notified: false,
    startedAt: Date.now(),
    timeoutAt: Date.now() + commandTimeout,
    process: childProcess,
    abortController,
    timeoutHandle,
    cwd: executionCwd,
    ...(options?.backgroundTask?.sessionId
      ? { sessionId: options.backgroundTask.sessionId }
      : {}),
    outputFile,
  }

  const countNewlines = (chunk: string): number => {
    let count = 0
    for (let i = 0; i < chunk.length; i++) {
      if (chunk.charCodeAt(i) === 10) count++
    }
    return count
  }

  // Cap buffered output to prevent unbounded memory growth for
  // long-running background processes (e.g. tail -f, build watchers).
  const MAX_BUFFERED_BYTES = 1 << 20 // 1 MiB
  const appendBuffer = (target: 'stdout' | 'stderr', chunk: string): void => {
    const key = target
    if (backgroundProcess[key].length + chunk.length > MAX_BUFFERED_BYTES) {
      const excess =
        backgroundProcess[key].length + chunk.length - MAX_BUFFERED_BYTES
      backgroundProcess[key] = backgroundProcess[key].slice(excess)
    }
    backgroundProcess[key] += chunk
  }

  startStreamReader(childProcess.stdout, chunk => {
    appendBuffer('stdout', chunk)
    appendTaskOutput(bashId, chunk)
    backgroundProcess.stdoutLineCount += countNewlines(chunk)
  })
  startStreamReader(childProcess.stderr, chunk => {
    appendBuffer('stderr', chunk)
    appendTaskOutput(bashId, chunk)
    backgroundProcess.stderrLineCount += countNewlines(chunk)
  })

  const completion = exitPromise.then<BackgroundShellCompletion>(
    exitOutcome => {
      backgroundProcess.code =
        exitOutcome.kind === 'exit' ? (exitOutcome.code ?? 0) : 2
      if (exitOutcome.kind === 'error') {
        const previousStderr = backgroundProcess.stderr
        backgroundProcess.stderr = [
          backgroundProcess.stderr,
          exitOutcome.error.message,
        ]
          .filter(Boolean)
          .join('\n')
        if (exitOutcome.error.message) {
          const delta = previousStderr
            ? `\n${exitOutcome.error.message}`
            : exitOutcome.error.message
          appendTaskOutput(bashId, delta)
          backgroundProcess.stderrLineCount += countNewlines(delta)
        }
      }
      backgroundProcess.interrupted =
        backgroundProcess.interrupted || abortController.signal.aborted
      if (sandbox?.enabled === true) {
        const annotated = annotateStderrWithSandboxViolations({
          command,
          stderr: backgroundProcess.stderr,
          sandbox,
        })
        if (annotated !== backgroundProcess.stderr) {
          const delta = annotated.startsWith(backgroundProcess.stderr)
            ? annotated.slice(backgroundProcess.stderr.length)
            : ''
          if (delta) {
            appendTaskOutput(bashId, delta)
            backgroundProcess.stderrLineCount += countNewlines(delta)
          }
          backgroundProcess.stderr = annotated
        }
      }
      if (backgroundProcess.timeoutHandle) {
        clearTimeout(backgroundProcess.timeoutHandle)
        backgroundProcess.timeoutHandle = null
      }
      flushTaskOutput(bashId)
      backgroundProcess.completedAt =
        backgroundProcess.completedAt ?? Date.now()
      const status: BackgroundShellCompletion['status'] =
        backgroundProcess.killed
          ? 'killed'
          : backgroundProcess.code === 0
            ? 'completed'
            : 'failed'
      return {
        taskId: bashId,
        status,
        exitCode: backgroundProcess.code,
        interrupted: backgroundProcess.interrupted,
        ...(exitOutcome.kind === 'error'
          ? { error: exitOutcome.error.message }
          : {}),
      }
    },
  )

  state.backgroundProcesses.set(bashId, backgroundProcess)
  return {
    bashId,
    ...(typeof childProcess.pid === 'number' ? { pid: childProcess.pid } : {}),
    completion,
  }
}

export function getBackgroundOutput(
  state: BunShellState,
  shellId: string,
): {
  stdout: string
  stderr: string
  code: number | null
  interrupted: boolean
  killed: boolean
  timedOut: boolean
  running: boolean
  command: string
  cwd: string
  startedAt: number
  timeoutAt: number
  outputFile: string
} | null {
  const proc = state.backgroundProcesses.get(shellId)
  if (!proc) return null
  const running = proc.code === null && !proc.interrupted
  return {
    stdout: proc.stdout,
    stderr: proc.stderr,
    code: proc.code,
    interrupted: proc.interrupted,
    killed: proc.killed,
    timedOut: proc.timedOut,
    running,
    command: proc.command,
    cwd: proc.cwd,
    startedAt: proc.startedAt,
    timeoutAt: proc.timeoutAt,
    outputFile: proc.outputFile,
  }
}

export function readBackgroundOutput(
  state: BunShellState,
  bashId: string,
  options?: { filter?: string },
): {
  shellId: string
  command: string
  cwd: string
  startedAt: number
  timeoutAt: number
  status: 'running' | 'completed' | 'failed' | 'killed'
  exitCode: number | null
  stdout: string
  stderr: string
  stdoutLines: number
  stderrLines: number
  filterPattern?: string
} | null {
  const proc = state.backgroundProcesses.get(bashId)
  if (!proc) return null

  const stdoutDelta = proc.stdout.slice(proc.stdoutCursor)
  const stderrDelta = proc.stderr.slice(proc.stderrCursor)

  // Consume all new output (incremental semantics: only new output since last check)
  proc.stdoutCursor = proc.stdout.length
  proc.stderrCursor = proc.stderr.length

  const stdoutLines = stdoutDelta === '' ? 0 : stdoutDelta.split('\n').length
  const stderrLines = stderrDelta === '' ? 0 : stderrDelta.split('\n').length

  let stdoutToReturn = stdoutDelta
  let stderrToReturn = stderrDelta

  const filter = options?.filter?.trim()
  if (filter) {
    const regex = new RegExp(filter, 'i')
    stdoutToReturn = stdoutDelta
      .split('\n')
      .filter(line => regex.test(line))
      .join('\n')
    stderrToReturn = stderrDelta
      .split('\n')
      .filter(line => regex.test(line))
      .join('\n')
  }

  const status: 'running' | 'completed' | 'failed' | 'killed' = proc.killed
    ? 'killed'
    : proc.code === null
      ? 'running'
      : proc.code === 0
        ? 'completed'
        : 'failed'

  return {
    shellId: bashId,
    command: proc.command,
    cwd: proc.cwd,
    startedAt: proc.startedAt,
    timeoutAt: proc.timeoutAt,
    status,
    exitCode: proc.code,
    stdout: stdoutToReturn,
    stderr: stderrToReturn,
    stdoutLines,
    stderrLines,
    ...(filter ? { filterPattern: filter } : {}),
  }
}

export function killBackgroundShell(
  state: BunShellState,
  shellId: string,
): boolean {
  const proc = state.backgroundProcesses.get(shellId)
  if (!proc) return false
  try {
    proc.interrupted = true
    proc.killed = true
    proc.completedAt = proc.completedAt ?? Date.now()
    proc.abortController.abort()
    proc.process.kill()
    if (proc.timeoutHandle) {
      clearTimeout(proc.timeoutHandle)
      proc.timeoutHandle = null
    }
    return true
  } catch {
    return false
  }
}

export function listBackgroundShells(
  state: BunShellState,
): BackgroundProcess[] {
  return Array.from(state.backgroundProcesses.values())
}

type ProcessStatus = 'running' | 'completed' | 'failed' | 'killed'

function statusFor(proc: BackgroundProcess): ProcessStatus {
  return proc.killed
    ? 'killed'
    : proc.code === null
      ? 'running'
      : proc.code === 0
        ? 'completed'
        : 'failed'
}

export function flushBashNotifications(
  state: BunShellState,
): BashNotification[] {
  const processes = Array.from(state.backgroundProcesses.values())

  const notifications: BashNotification[] = []

  for (const proc of processes) {
    if (proc.notified) continue
    const status = statusFor(proc)
    if (status === 'running') continue

    notifications.push({
      type: 'bash_notification',
      taskId: proc.id,
      taskType: 'local_bash',
      description: proc.command,
      outputFile: proc.outputFile || getTaskOutputFilePath(proc.id),
      status,
      ...(proc.code !== null ? { exitCode: proc.code } : {}),
    })

    proc.notified = true
  }

  return notifications
}

export function flushBackgroundShellStatusAttachments(
  state: BunShellState,
): BackgroundShellStatusAttachment[] {
  const processes = Array.from(state.backgroundProcesses.values())

  const progressAttachments: BackgroundShellStatusAttachment[] = []

  for (const proc of processes) {
    if (statusFor(proc) !== 'running') continue

    const stdoutDelta = proc.stdoutLineCount - proc.lastReportedStdoutLines
    const stderrDelta = proc.stderrLineCount - proc.lastReportedStderrLines
    if (stdoutDelta === 0 && stderrDelta === 0) continue

    proc.lastReportedStdoutLines = proc.stdoutLineCount
    proc.lastReportedStderrLines = proc.stderrLineCount

    progressAttachments.push({
      type: 'task_progress',
      taskId: proc.id,
      stdoutLineDelta: stdoutDelta,
      stderrLineDelta: stderrDelta,
      outputFile: proc.outputFile || getTaskOutputFilePath(proc.id),
    })
  }

  return progressAttachments
}
