import { spawn } from 'node:child_process'
import type {
  BackgroundProcess,
  BunShellExecOptions,
  BunShellPromotableExec,
  BunShellPromotableExecStatus,
} from './types'
import type { BunShellState } from './state'
import {
  appendTaskOutput,
  flushTaskOutput,
  touchTaskOutputFile,
} from '../taskOutputStore'
import { buildSandboxCommand } from './sandboxCommand'
import { annotateStderrWithSandboxViolations } from './sandboxViolations'
import { createCancellableTextCollector } from './streamReaders'
import { getShellCmdForPlatform, getShellStdioForPlatform } from './shellCmd'
import { makeBackgroundTaskId } from './ids'

type ExecResult = {
  stdout: string
  stderr: string
  code: number
  interrupted: boolean
}

function normalizeExitCode(code: number | null, interrupted: boolean): number {
  if (typeof code === 'number' && Number.isFinite(code)) return code
  return interrupted ? 143 : 0
}

export function execPromotable(
  state: BunShellState,
  command: string,
  abortSignal?: AbortSignal,
  timeout?: number,
  options?: BunShellExecOptions,
): BunShellPromotableExec {
  const DEFAULT_TIMEOUT = 120_000
  const commandTimeout = timeout ?? DEFAULT_TIMEOUT
  const startedAt = Date.now()

  const sandbox = options?.sandbox
  const shouldAttemptSandbox = sandbox?.enabled === true
  const executionCwd =
    (shouldAttemptSandbox && sandbox?.chdir) || options?.cwd || state.cwd

  if (abortSignal?.aborted) {
    return {
      get status(): BunShellPromotableExecStatus {
        return 'killed'
      },
      background: () => null,
      kill: () => {},
      result: Promise.resolve({
        stdout: '',
        stderr: 'Command aborted before execution',
        code: 145,
        interrupted: true,
      }),
    }
  }

  const sandboxCmd = shouldAttemptSandbox
    ? buildSandboxCommand({ command, sandbox: sandbox!, cwd: executionCwd })
    : null
  if (shouldAttemptSandbox && sandbox?.require && !sandboxCmd) {
    return {
      get status(): BunShellPromotableExecStatus {
        return 'killed'
      },
      background: () => null,
      kill: () => {},
      result: Promise.resolve({
        stdout: '',
        stderr:
          'System sandbox is required but unavailable (missing bubblewrap or unsupported platform).',
        code: 2,
        interrupted: false,
      }),
    }
  }

  const cmdToRun = sandboxCmd
    ? sandboxCmd.cmd
    : getShellCmdForPlatform(process.platform, command, process.env)

  const internalAbortController = new AbortController()
  state.abortController = internalAbortController

  let status: BunShellPromotableExecStatus = 'running'
  let backgroundProcess: BackgroundProcess | null = null
  let backgroundTaskId: string | null = null
  let stdout = ''
  let stderr = ''
  let wasAborted = false
  let wasBackgrounded = false
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  let timedOut = false
  let onTimeoutCb:
    | ((background: (bashId?: string) => { bashId: string } | null) => void)
    | null = null

  const countNewlines = (chunk: string): number => {
    let count = 0
    for (let i = 0; i < chunk.length; i++) {
      if (chunk.charCodeAt(i) === 10) count++
    }
    return count
  }

  const spawnedProcess = spawn(cmdToRun[0]!, cmdToRun.slice(1), {
    cwd: executionCwd,
    stdio: getShellStdioForPlatform(process.platform),
  })
  state.currentProcess = spawnedProcess

  const exitPromise = new Promise<
    { kind: 'exit'; code: number | null } | { kind: 'error'; error: Error }
  >(resolve => {
    spawnedProcess.once('exit', code => resolve({ kind: 'exit', code }))
    spawnedProcess.once('error', error => resolve({ kind: 'error', error }))
  })

  const onAbort = () => {
    if (status === 'backgrounded') return
    wasAborted = true
    internalAbortController.abort()
    try {
      spawnedProcess.kill()
    } catch {
      // The process may already have exited.
    }
    if (backgroundProcess) backgroundProcess.interrupted = true
  }

  const clearForegroundGuards = () => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle)
      timeoutHandle = null
    }
    if (abortSignal) {
      abortSignal.removeEventListener('abort', onAbort)
    }
  }

  if (abortSignal) {
    abortSignal.addEventListener('abort', onAbort, { once: true })
    if (abortSignal.aborted) onAbort()
  }

  const stdoutCollector = createCancellableTextCollector(
    spawnedProcess.stdout,
    {
      collectText: false,
      onChunk: chunk => {
        stdout += chunk
        options?.onStdoutChunk?.(chunk)
        if (backgroundProcess) {
          backgroundProcess.stdout = stdout
          appendTaskOutput(backgroundProcess.id, chunk)
          backgroundProcess.stdoutLineCount += countNewlines(chunk)
        }
      },
    },
  )
  const stderrCollector = createCancellableTextCollector(
    spawnedProcess.stderr,
    {
      collectText: false,
      onChunk: chunk => {
        stderr += chunk
        options?.onStderrChunk?.(chunk)
        if (backgroundProcess) {
          backgroundProcess.stderr = stderr
          appendTaskOutput(backgroundProcess.id, chunk)
          backgroundProcess.stderrLineCount += countNewlines(chunk)
        }
      },
    },
  )

  timeoutHandle = setTimeout(() => {
    if (status !== 'running') return
    if (onTimeoutCb) {
      onTimeoutCb(background)
      return
    }
    timedOut = true
    try {
      spawnedProcess.kill()
    } catch {
      // The process may already have exited.
    }
    internalAbortController.abort()
  }, commandTimeout)

  const background = (bashId?: string): { bashId: string } | null => {
    if (backgroundTaskId) return { bashId: backgroundTaskId }
    if (status !== 'running') return null

    backgroundTaskId = bashId ?? makeBackgroundTaskId()
    const outputFile = touchTaskOutputFile(backgroundTaskId)
    if (stdout) appendTaskOutput(backgroundTaskId, stdout)
    if (stderr) appendTaskOutput(backgroundTaskId, stderr)

    status = 'backgrounded'
    wasBackgrounded = true
    clearForegroundGuards()

    backgroundProcess = {
      id: backgroundTaskId,
      command,
      stdout,
      stderr,
      stdoutCursor: 0,
      stderrCursor: 0,
      stdoutLineCount: countNewlines(stdout),
      stderrLineCount: countNewlines(stderr),
      lastReportedStdoutLines: 0,
      lastReportedStderrLines: 0,
      code: null,
      interrupted: false,
      killed: false,
      timedOut: false,
      completionStatusSentInAttachment: false,
      notified: false,
      startedAt,
      completedAt: undefined,
      timeoutAt: Number.POSITIVE_INFINITY,
      process: spawnedProcess,
      abortController: internalAbortController,
      timeoutHandle: null,
      cwd: executionCwd,
      outputFile,
    }

    state.backgroundProcesses.set(backgroundTaskId, backgroundProcess)

    // Foreground process is now managed as a background task.
    state.currentProcess = null
    state.abortController = null

    return { bashId: backgroundTaskId }
  }

  const kill = () => {
    status = 'killed'
    try {
      spawnedProcess.kill()
    } catch {
      // The process may already have exited.
    }
    internalAbortController.abort()

    if (backgroundProcess) {
      backgroundProcess.interrupted = true
      backgroundProcess.killed = true
      backgroundProcess.completedAt =
        backgroundProcess.completedAt ?? Date.now()
    }
  }

  const result = (async (): Promise<ExecResult> => {
    try {
      const exitOutcome = await exitPromise
      if (exitOutcome.kind === 'error') {
        stderr = [stderr, exitOutcome.error.message].filter(Boolean).join('\n')
      }

      if (status === 'running' || status === 'backgrounded')
        status = 'completed'

      // backgroundProcess is assigned inside background(), which TS's control
      // flow analysis cannot see from this IIFE, so re-widen the type here.
      const bgAtExit = backgroundProcess as BackgroundProcess | null
      if (bgAtExit) {
        bgAtExit.code =
          exitOutcome.kind === 'exit' ? (exitOutcome.code ?? 0) : 2
        bgAtExit.interrupted =
          bgAtExit.interrupted ||
          wasAborted ||
          internalAbortController.signal.aborted
        bgAtExit.completedAt = bgAtExit.completedAt ?? Date.now()
      }

      if (!wasBackgrounded) {
        await Promise.race([
          Promise.allSettled([stdoutCollector.done, stderrCollector.done]),
          new Promise(resolve => setTimeout(resolve, 250)),
        ])
        await Promise.allSettled([
          stdoutCollector.cancel(),
          stderrCollector.cancel(),
        ])
      }

      const interrupted =
        wasAborted ||
        abortSignal?.aborted === true ||
        internalAbortController.signal.aborted === true ||
        timedOut

      let code: number | null =
        exitOutcome.kind === 'exit' ? exitOutcome.code : null
      if (exitOutcome.kind === 'error') code = 2

      const stderrWithTimeout = timedOut
        ? [`Command timed out`, stderr].filter(Boolean).join('\n')
        : stderr
      const stderrAnnotated = sandboxCmd
        ? annotateStderrWithSandboxViolations({
            command,
            stderr: stderrWithTimeout,
            sandbox,
          })
        : stderrWithTimeout

      // Same narrowing workaround as above for backgroundProcess.
      const bgForStderr = backgroundProcess as BackgroundProcess | null
      if (bgForStderr && stderrAnnotated !== bgForStderr.stderr) {
        const previousStderr = bgForStderr.stderr
        bgForStderr.stderr = stderrAnnotated
        if (stderrAnnotated.startsWith(previousStderr)) {
          const delta = stderrAnnotated.slice(previousStderr.length)
          if (delta) {
            appendTaskOutput(bgForStderr.id, delta)
            bgForStderr.stderrLineCount += countNewlines(delta)
          }
        }
      }
      if (backgroundTaskId) flushTaskOutput(backgroundTaskId)

      return {
        stdout,
        stderr: stderrAnnotated,
        code: normalizeExitCode(code, interrupted),
        interrupted,
      }
    } finally {
      clearForegroundGuards()

      if (state.currentProcess === spawnedProcess) {
        state.currentProcess = null
        state.abortController = null
      }
    }
  })()

  const execHandle: BunShellPromotableExec = {
    get status() {
      return status
    },
    background,
    kill,
    result,
  }

  execHandle.onTimeout = cb => {
    onTimeoutCb = cb
  }

  // Keep background task metadata updated even if the caller doesn't await `result`.
  result
    .then(r => {
      if (!backgroundProcess || !backgroundTaskId) return
      backgroundProcess.code = r.code
      backgroundProcess.interrupted = r.interrupted
    })
    .catch(() => {
      if (!backgroundProcess) return
      backgroundProcess.code = backgroundProcess.code ?? 2
    })

  return execHandle
}
