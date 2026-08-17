import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export type ExternalRuntimeCommand = {
  command: string
  args: string[]
}

export type ExternalRuntimeCommandResult = {
  exitCode: number | null
  stdout: string
  stderr: string
}

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_OUTPUT_BYTES = 1024 * 1024

function usesWindowsShell(): boolean {
  return process.platform === 'win32'
}

function commandFromPackage(
  packageEntry: string,
  args: string[],
): ExternalRuntimeCommand | null {
  try {
    return {
      command: process.execPath,
      args: [require.resolve(packageEntry), ...args],
    }
  } catch {
    return null
  }
}

/**
 * Use a project-installed command first. This keeps OAuth flows versioned with
 * Kode instead of relying on an unrelated global executable on PATH.
 */
export function getCopilotCommand(args: string[] = []): ExternalRuntimeCommand {
  return (
    commandFromPackage('@github/copilot/npm-loader.js', args) ?? {
      command: process.platform === 'win32' ? 'copilot.cmd' : 'copilot',
      args,
    }
  )
}

export function getGrokCommand(args: string[] = []): ExternalRuntimeCommand {
  return (
    commandFromPackage('@xai-official/grok/bin/grok', args) ?? {
      command: process.platform === 'win32' ? 'grok.cmd' : 'grok',
      args,
    }
  )
}

export function startExternalRuntimeLogin(
  command: ExternalRuntimeCommand,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      detached: true,
      shell: usesWindowsShell(),
      stdio: 'ignore',
      windowsHide: true,
    })

    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

export function runExternalRuntimeCommand(
  command: ExternalRuntimeCommand,
  options: { timeoutMs?: number } = {},
): Promise<ExternalRuntimeCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      shell: usesWindowsShell(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    let settled = false

    const finish = (error?: Error, result?: ExternalRuntimeCommandResult) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (!child.killed) child.kill()
      if (error) reject(error)
      else if (result) resolve(result)
    }
    const timeout = setTimeout(
      () => finish(new Error('External runtime command timed out')),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
    const append = (target: 'stdout' | 'stderr', chunk: string) => {
      outputBytes += Buffer.byteLength(chunk)
      if (outputBytes > MAX_OUTPUT_BYTES) {
        finish(new Error('External runtime command produced too much output'))
        return
      }
      if (target === 'stdout') stdout += chunk
      else stderr += chunk
    }

    child.once('error', error => finish(error))
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', chunk => append('stdout', chunk))
    child.stderr?.on('data', chunk => append('stderr', chunk))
    child.once('close', exitCode =>
      finish(undefined, { exitCode, stdout, stderr }),
    )
  })
}
