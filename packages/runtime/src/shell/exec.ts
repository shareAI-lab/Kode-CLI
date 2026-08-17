import { spawn } from 'node:child_process'
import type { BunShellExecOptions } from './types'
import type { BunShellState } from './state'
import { buildSandboxCommand, isSandboxInitFailure } from './sandboxCommand'
import { annotateStderrWithSandboxViolations } from './sandboxViolations'
import { createCancellableTextCollector } from './streamReaders'
import { getShellCmdForPlatform, getShellStdioForPlatform } from './shellCmd'

function logError(error: unknown): void {
  if (process.env.NODE_ENV === 'test') {
    console.error(error)
  }
}

type ExecResult = {
  stdout: string
  stderr: string
  code: number
  interrupted: boolean
}

function normalizeExitCode(
  exitCode: number | null,
  interrupted: boolean,
): number {
  if (typeof exitCode === 'number' && Number.isFinite(exitCode)) return exitCode
  return interrupted ? 143 : 0
}

export async function exec(
  state: BunShellState,
  command: string,
  abortSignal?: AbortSignal,
  timeout?: number,
  options?: BunShellExecOptions,
): Promise<ExecResult> {
  const DEFAULT_TIMEOUT = 120_000
  const commandTimeout = timeout ?? DEFAULT_TIMEOUT

  state.abortController = new AbortController()
  let wasAborted = false
  const onAbort = () => {
    wasAborted = true
    state.abortController?.abort()
    try {
      state.currentProcess?.kill()
    } catch {
      // The process may already have exited.
    }
  }

  // Link external abort signal
  if (abortSignal) {
    abortSignal.addEventListener('abort', onAbort, { once: true })
  }

  const sandbox = options?.sandbox
  const shouldAttemptSandbox = sandbox?.enabled === true
  const executionCwd =
    (shouldAttemptSandbox && sandbox?.chdir) || options?.cwd || state.cwd

  const runOnce = async (
    cmd: string[],
    cwdOverride?: string,
  ): Promise<ExecResult> => {
    const stdio = getShellStdioForPlatform(process.platform)
    if (options?.stdin !== undefined) stdio[0] = 'pipe'

    state.currentProcess = spawn(cmd[0]!, cmd.slice(1), {
      cwd: cwdOverride ?? executionCwd,
      stdio,
    })
    const processRef = state.currentProcess

    if (options?.stdin !== undefined && processRef.stdin) {
      try {
        processRef.stdin.write(options.stdin)
      } catch {
        /* no-op */
      }
      try {
        processRef.stdin.end()
      } catch {
        /* no-op */
      }
    }

    const exitPromise = new Promise<
      { kind: 'exit'; code: number | null } | { kind: 'error'; error: Error }
    >(resolve => {
      processRef.once('exit', code => resolve({ kind: 'exit', code }))
      processRef.once('error', error => resolve({ kind: 'error', error }))
    })

    const stdoutCollector = createCancellableTextCollector(processRef.stdout, {
      onChunk: options?.onStdoutChunk,
    })
    const stderrCollector = createCancellableTextCollector(processRef.stderr, {
      onChunk: options?.onStderrChunk,
    })

    // Use Promise.race for real timeout - don't trust signal option alone
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null
    const timeoutPromise = new Promise<'timeout'>(resolve => {
      timeoutHandle = setTimeout(() => resolve('timeout'), commandTimeout)
    })

    const result = await Promise.race([
      exitPromise.then(() => 'completed' as const),
      timeoutPromise,
    ])
    if (timeoutHandle) clearTimeout(timeoutHandle)

    if (result === 'timeout') {
      // Actually kill the process
      try {
        processRef.kill()
      } catch {
        // The process may already have exited.
      }
      state.abortController?.abort()

      await exitPromise

      // Ensure we don't hang reading stdout/stderr if a background child keeps fds open.
      await Promise.race([
        Promise.allSettled([stdoutCollector.done, stderrCollector.done]),
        new Promise(resolve => setTimeout(resolve, 250)),
      ])
      await Promise.allSettled([
        stdoutCollector.cancel(),
        stderrCollector.cancel(),
      ])
      return {
        stdout: '',
        stderr: 'Command timed out',
        code: 143,
        interrupted: true,
      }
    }

    // Process completed normally.
    // NOTE: stdout/stderr pipes may never reach EOF if the command backgrounds a child
    // process (e.g. `python -m http.server &`). In that case, we drain briefly and then
    // cancel readers to avoid hanging forever.
    await Promise.race([
      Promise.allSettled([stdoutCollector.done, stderrCollector.done]),
      new Promise(resolve => setTimeout(resolve, 250)),
    ])
    await Promise.allSettled([
      stdoutCollector.cancel(),
      stderrCollector.cancel(),
    ])

    const stdout = stdoutCollector.getText()
    let stderr = stderrCollector.getText()
    const interrupted =
      wasAborted ||
      abortSignal?.aborted === true ||
      state.abortController?.signal.aborted === true
    const exitOutcome = await exitPromise
    if (exitOutcome.kind === 'error') {
      stderr = [stderr, exitOutcome.error.message].filter(Boolean).join('\n')
    }
    let exitCode: number | null =
      exitOutcome.kind === 'exit' ? exitOutcome.code : null
    if (exitOutcome.kind === 'error') exitCode = 2

    return {
      stdout,
      stderr,
      code: normalizeExitCode(exitCode, interrupted),
      interrupted,
    }
  }

  try {
    if (shouldAttemptSandbox) {
      const sandboxCmd = buildSandboxCommand({
        command,
        sandbox: sandbox!,
        cwd: executionCwd,
      })
      if (!sandboxCmd) {
        if (sandbox?.require) {
          return {
            stdout: '',
            stderr:
              'System sandbox is required but unavailable (missing bubblewrap or unsupported platform).',
            code: 2,
            interrupted: false,
          }
        }
        const fallback = await runOnce(
          getShellCmdForPlatform(process.platform, command, process.env),
        )
        return fallback
      }

      const sandboxed = await runOnce(sandboxCmd.cmd)
      sandboxed.stderr = annotateStderrWithSandboxViolations({
        command,
        stderr: sandboxed.stderr,
        sandbox,
      })
      if (
        !sandboxed.interrupted &&
        sandboxed.code !== 0 &&
        isSandboxInitFailure(sandboxed.stderr) &&
        !sandbox?.require
      ) {
        const fallback = await runOnce(
          getShellCmdForPlatform(process.platform, command, process.env),
        )
        return fallback
      }

      return sandboxed
    }

    return await runOnce(
      getShellCmdForPlatform(process.platform, command, process.env),
    )
  } catch (error) {
    // Handle external abort
    if (state.abortController?.signal.aborted) {
      state.currentProcess?.kill()
      return {
        stdout: '',
        stderr: 'Command was interrupted',
        code: 143,
        interrupted: true,
      }
    }

    const errorStr = error instanceof Error ? error.message : String(error)
    logError(`Shell execution error: ${errorStr}`)

    return {
      stdout: '',
      stderr: errorStr,
      code: 2,
      interrupted: false,
    }
  } finally {
    if (abortSignal) {
      abortSignal.removeEventListener('abort', onAbort)
    }
    // Kill any surviving child process to prevent orphans
    if (state.currentProcess && !state.currentProcess.killed) {
      state.currentProcess.kill()
    }
    state.currentProcess = null
    state.abortController = null
  }
}
