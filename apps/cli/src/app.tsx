import '#core/utils/sanitizeAnthropicEnv'
import { initDebugLogger } from '#core/utils/debugLogger'
import { logError } from '#core/utils/log'
import { ConfigParseError } from '#core/utils/errors'
import { enableConfigs, getGlobalConfig } from '#config'
import { ensurePackagedRuntimeEnv, ensureYogaWasmPath } from './bootstrapEnv'
import {
  enableLineWrapping,
  enterAlternateScreen,
  exitAlternateScreen,
  resetMouseEvents,
  shouldEnterAlternateScreen,
} from '#cli-utils/terminal'
import { setCliExitHandler } from '#cli-utils/exit'
import {
  restoreTuiStdioPatch,
  writeToStderr,
  writeToStdout,
} from '#cli-utils/stdio'
import { isPrintModeSignalAbortHandlingActive } from '#host-cli/entrypoints/cli/print/signalState'

import { cursorShow } from 'ansi-escapes'
import { openSync } from 'fs'
import { cwd } from 'process'
import { ReadStream } from 'tty'

// ink and REPL are imported lazily to avoid top-level awaits during module init
import type { RenderOptions } from 'ink'

let didEnterAlternateScreen = false

// Cached reference for the exit handler (loaded lazily in runCli)
let _terminalCapabilityManager: { disableAllModes(): void } | null = null
// Loaded lazily once the interactive/repl path is reached; exit cleanup only
// closes the shell when it was actually started (headless runs never import it).
let shellCloser: (() => void) | null = null

function wantsPrintMode(): boolean {
  const readFlagValue = (flag: string): string | null => {
    const prefix = `${flag}=`
    for (let i = 0; i < process.argv.length; i += 1) {
      const arg = process.argv[i]
      if (arg === flag) return process.argv[i + 1] ?? null
      if (arg?.startsWith(prefix)) return arg.slice(prefix.length)
    }
    return null
  }

  const outputFormat = String(readFlagValue('--output-format') ?? 'text')
    .toLowerCase()
    .trim()
  const inputFormat = String(readFlagValue('--input-format') ?? 'text')
    .toLowerCase()
    .trim()

  return (
    process.argv.includes('-p') ||
    process.argv.includes('--print') ||
    process.argv.includes('--headless') ||
    outputFormat === 'json' ||
    outputFormat === 'stream-json' ||
    inputFormat === 'stream-json'
  )
}

const daemonLifecycleActions = new Set(['start', 'status', 'stop'])

function isDaemonLifecycleCommand(): boolean {
  const args = process.argv.slice(2)
  const daemonIndex = args.indexOf('daemon')
  return (
    daemonIndex >= 0 && daemonLifecycleActions.has(args[daemonIndex + 1] ?? '')
  )
}

function releaseNonInteractiveDaemonStdin(): void {
  if (process.stdin.isTTY) return
  process.stdin.pause()
  process.stdin.destroy()
}

function flushStream(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise(resolve => {
    stream.write('', () => resolve())
  })
}

async function exitDaemonLifecycleCommand(): Promise<never> {
  releaseNonInteractiveDaemonStdin()
  await Promise.all([flushStream(process.stdout), flushStream(process.stderr)])
  process.exit(process.exitCode ?? 0)
}

export async function runCli(): Promise<void> {
  ensurePackagedRuntimeEnv()
  ensureYogaWasmPath(import.meta.url)

  // 初始化调试日志系统
  initDebugLogger()

  // Validate configs are valid and enable configuration system
  try {
    enableConfigs()

    queueMicrotask(() => {
      import('#core/runs')
        .then(({ reconcileDurableRuns, probeDurableRunProcess }) => {
          try {
            reconcileDurableRuns({ probeProcess: probeDurableRunProcess })
          } catch (error) {
            logError(error)
          }
        })
        .catch(error => logError(error))
    })

    // 🔧 Validate and auto-repair GPT-5 model profiles (best-effort, non-blocking)
    // Avoid printing during interactive render; log to file on failure.
    queueMicrotask(() => {
      import('#config')
        .then(({ validateAndRepairAllGPT5Profiles }) => {
          try {
            validateAndRepairAllGPT5Profiles()
          } catch (repairError) {
            logError(`GPT-5 configuration validation failed: ${repairError}`)
          }
        })
        .catch(repairError => {
          logError(`GPT-5 configuration validation failed: ${repairError}`)
        })
    })
  } catch (error: unknown) {
    if (error instanceof ConfigParseError) {
      const { showInvalidConfigDialog } =
        await import('#ui-ink/screens/setup/InvalidConfigScreen')
      await showInvalidConfigDialog({ error })
      return
    }
  }

  const config = getGlobalConfig()
  const screenReaderEnv =
    process.env.KODE_SCREEN_READER ?? process.env.SCREENREADER
  const isScreenReader = Boolean(screenReaderEnv)

  if (
    shouldEnterAlternateScreen(
      config.useAlternateBuffer ?? false,
      isScreenReader,
    ) &&
    process.stdin.isTTY &&
    process.stdout.isTTY &&
    !wantsPrintMode()
  ) {
    enterAlternateScreen()
    didEnterAlternateScreen = true
  }

  // Disabled background notifier to avoid mid-screen logs during REPL

  let inputPrompt = ''
  let renderContext: RenderOptions | undefined = {
    exitOnCtrlC: false,
  }

  const wantsStreamJsonStdin =
    process.argv.some(
      (arg, idx, all) =>
        arg === '--input-format' && all[idx + 1] === 'stream-json',
    ) || process.argv.some(arg => arg.startsWith('--input-format=stream-json'))

  if (
    !process.stdin.isTTY &&
    !process.env.CI &&
    // Input hijacking breaks MCP.
    !process.argv.includes('mcp') &&
    // Lifecycle commands are explicitly non-interactive and must work in CI.
    !isDaemonLifecycleCommand() &&
    !wantsStreamJsonStdin
  ) {
    inputPrompt = await stdin()
    if (process.platform !== 'win32') {
      try {
        const ttyFd = openSync('/dev/tty', 'r')
        renderContext = { ...renderContext, stdin: new ReadStream(ttyFd) }
      } catch (err) {
        logError(`Could not open /dev/tty: ${err}`)
      }
    }
  }
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const { terminalCapabilityManager } =
      await import('#ui-ink/utils/terminalCapabilityManager')
    _terminalCapabilityManager = terminalCapabilityManager
    await terminalCapabilityManager.detectCapabilities()
    terminalCapabilityManager.enableSupportedModes()
  }
  const { parseArgs } = await import('#host-cli')
  preloadShellForExit()
  await parseArgs(inputPrompt, renderContext)
  if (isDaemonLifecycleCommand()) await exitDaemonLifecycleCommand()
}

// Preload the shell only for paths that can run background tasks (interactive
// REPL or headless agent runs), so --version/--print/help stay lean.
function preloadShellForExit(): void {
  if (shellCloser) return
  import('#runtime/shell')
    .then(({ BunShell }) => {
      shellCloser = () => BunShell.getInstance().close()
    })
    .catch(() => {
      /* shell is optional for cleanup */
    })
} // NOTE: stdin is currently buffered; streaming can be added if needed.
async function stdin() {
  if (process.stdin.isTTY) {
    return ''
  }

  let data = ''
  for await (const chunk of process.stdin) data += chunk
  return data
}

process.on('exit', () => {
  try {
    restoreTuiStdioPatch()
  } catch {
    // Exit cleanup must not prevent process termination.
  }
  try {
    enableLineWrapping()
  } catch {
    // Exit cleanup must not prevent process termination.
  }
  try {
    resetMouseEvents()
  } catch {
    // Exit cleanup must not prevent process termination.
  }
  resetCursor()
  if (didEnterAlternateScreen) {
    exitAlternateScreen()
  }
  shellCloser?.()
  _terminalCapabilityManager?.disableAllModes()
})

let isGracefulExitInProgress = false
async function gracefulExit(code = 0) {
  if (isGracefulExitInProgress) {
    process.exit(code)
    return
  }
  isGracefulExitInProgress = true

  try {
    const { runSessionEndHooks } = await import('@kode/hooks')
    const { getKodeAgentSessionId } =
      await import('#protocol/utils/kodeAgentSessionId')
    const { tmpdir } = await import('os')
    const { join } = await import('path')

    const sessionId = getKodeAgentSessionId()
    const transcriptPath = join(
      tmpdir(),
      'kode-hooks-transcripts',
      `${sessionId}.transcript.txt`,
    )

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    const signal = controller.signal
    const cleanup = () => clearTimeout(timer)

    try {
      await runSessionEndHooks({
        reason: 'exit',
        cwd: cwd(),
        transcriptPath,
        signal,
      })
    } finally {
      cleanup()
    }
  } catch {
    // best-effort only
  }

  try {
    resetCursor()
  } catch {
    // Exit cleanup must not prevent process termination.
  }
  try {
    enableLineWrapping()
  } catch {
    // Exit cleanup must not prevent process termination.
  }
  try {
    resetMouseEvents()
  } catch {
    // Exit cleanup must not prevent process termination.
  }
  if (didEnterAlternateScreen) {
    try {
      exitAlternateScreen()
    } catch {
      // Exit cleanup must not prevent process termination.
    }
  }
  try {
    shellCloser?.()
  } catch {
    // Exit cleanup must not prevent process termination.
  }
  process.exit(code)
}

setCliExitHandler(gracefulExit)

function handleProcessSignalExit(code = 0): void {
  if (isPrintModeSignalAbortHandlingActive()) return
  void gracefulExit(code)
}

process.on('SIGINT', () => handleProcessSignalExit(0))
process.on('SIGTERM', () => handleProcessSignalExit(0))
// Windows CTRL+BREAK
process.on('SIGBREAK', () => handleProcessSignalExit(0))
process.on('unhandledRejection', err => {
  logError(err)
  void gracefulExit(1)
})
process.on('uncaughtException', err => {
  logError(err)
  void gracefulExit(1)
})

function resetCursor() {
  if (process.stderr.isTTY) {
    writeToStderr(cursorShow)
    return
  }

  if (process.stdout.isTTY) {
    writeToStdout(cursorShow)
  }
}
