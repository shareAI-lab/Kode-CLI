import { spawn, spawnSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { extname, join } from 'path'
import { parse } from 'shell-quote'
import {
  disableLineWrapping,
  enableLineWrapping,
  resumeMouseEvents,
  suspendMouseEvents,
  withEphemeralAlternateScreen,
} from '#cli-utils/terminal'
import { writeToStdout } from '#cli-utils/stdio'
import { getInkInstanceForStdout } from '#ui-ink/utils/inkInstanceStore'
import { terminalCapabilityManager } from '#ui-ink/utils/terminalCapabilityManager'

type EditorCommand = {
  command: string
  args: string[]
  displayName: string
  shell?: boolean
}

export type ExternalEditorDependencies = {
  spawn: typeof spawn
  spawnSync: typeof spawnSync
  disableLineWrapping: typeof disableLineWrapping
  enableLineWrapping: typeof enableLineWrapping
  resumeMouseEvents: typeof resumeMouseEvents
  suspendMouseEvents: typeof suspendMouseEvents
  withEphemeralAlternateScreen: typeof withEphemeralAlternateScreen
  writeToStdout: typeof writeToStdout
  getInkInstanceForStdout: typeof getInkInstanceForStdout
  terminalCapabilityManager: Pick<
    typeof terminalCapabilityManager,
    'disableAllModes' | 'enableSupportedModes'
  >
}

const defaultDependencies: ExternalEditorDependencies = {
  spawn,
  spawnSync,
  disableLineWrapping,
  enableLineWrapping,
  resumeMouseEvents,
  suspendMouseEvents,
  withEphemeralAlternateScreen,
  writeToStdout,
  getInkInstanceForStdout,
  terminalCapabilityManager,
}

let dependencyLoader = (): ExternalEditorDependencies => defaultDependencies

export function __setExternalEditorDependencyLoaderForTests(
  loader: (() => ExternalEditorDependencies) | null,
): void {
  dependencyLoader = loader ?? (() => defaultDependencies)
}

const isWindows = process.platform === 'win32'

function parseWindowsCommandLine(commandLine: string): string[] | null {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null

  for (const character of commandLine.trim()) {
    if (quote) {
      if (character === quote) quote = null
      else current += character
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (/\s/u.test(character)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += character
  }

  if (quote) return null
  if (current) tokens.push(current)
  return tokens
}

export function parseExternalEditorCommand(
  commandLine: string,
  platform: NodeJS.Platform = process.platform,
): EditorCommand | null {
  const rawTokens =
    platform === 'win32'
      ? parseWindowsCommandLine(commandLine)
      : parse(commandLine, variableName => `$${variableName}`)
  if (
    !rawTokens?.length ||
    rawTokens.some(
      token => typeof token !== 'string' || /[;&|<>`\r\n]/u.test(token),
    )
  ) {
    return null
  }

  const [command, ...args] = rawTokens as string[]
  if (!command) return null
  return {
    command,
    args,
    displayName: commandLine.trim(),
  }
}

function assertSafeShellFilePath(filePath: string): void {
  if (/[\r\n&|<>()^%!"]/u.test(filePath)) {
    throw new Error(
      'The selected file path contains characters that are unsafe for this Windows editor launcher.',
    )
  }
}

function showTerminalCursor(dependencies: ExternalEditorDependencies): void {
  if (!process.stdout?.isTTY) return
  // Reset styles + show cursor for full-screen editors.
  dependencies.writeToStdout('\x1b[0m\x1b[?25h')
}

function hideTerminalCursor(dependencies: ExternalEditorDependencies): void {
  if (!process.stdout?.isTTY) return
  dependencies.writeToStdout('\x1b[?25l')
}

async function withSuspendedInk<T>(
  dependencies: ExternalEditorDependencies,
  fn: () => Promise<T> | T,
): Promise<T> {
  const stdout = process.stdout as NodeJS.WriteStream
  const instance = dependencies.getInkInstanceForStdout(stdout)
  const hasInk = Boolean(instance)
  const screenReaderEnv =
    process.env.KODE_SCREEN_READER ?? process.env.SCREENREADER

  try {
    instance?.pause?.()
    instance?.suspendStdin?.()
    dependencies.terminalCapabilityManager.disableAllModes()
    dependencies.suspendMouseEvents()
    dependencies.enableLineWrapping()
    showTerminalCursor(dependencies)
    return await dependencies.withEphemeralAlternateScreen(fn)
  } finally {
    if (hasInk) {
      hideTerminalCursor(dependencies)
      if (!screenReaderEnv) {
        dependencies.disableLineWrapping()
      }
    }
    dependencies.terminalCapabilityManager.enableSupportedModes()
    dependencies.resumeMouseEvents()
    instance?.resumeStdin?.()
    instance?.resume?.()
  }
}

function isCommandAvailable(
  command: string,
  dependencies: ExternalEditorDependencies,
): boolean {
  const checker = isWindows ? 'where' : 'which'
  const result = dependencies.spawnSync(checker, [command], {
    stdio: 'ignore',
  })
  return result.status === 0
}

function resolveEditorCommand(
  dependencies: ExternalEditorDependencies,
): EditorCommand | null {
  return buildEditorCommandCandidates(dependencies)[0] ?? null
}

function isEnvVarToken(token: string): string | null {
  const match =
    /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/.exec(token)
  return match ? (match[1] ?? match[2]!) : null
}

/**
 * Expands `~`, `~/...`, `$VAR`, and `${VAR}` tokens so editors configured as
 * `$EDITOR="$HOME/bin/editor"` or `~/.local/bin/editor` work without a shell.
 */
function expandEditorCommand(editorCommand: EditorCommand): EditorCommand {
  const expand = (token: string): string => {
    if (token === '~') return homedir()
    if (token.startsWith('~/')) return join(homedir(), token.slice(2))
    const envName = isEnvVarToken(token)
    if (envName) {
      const value = process.env[envName]
      if (value) {
        return value + token.slice(token.indexOf(envName) + envName.length)
      }
    }
    return token
  }
  return {
    ...editorCommand,
    command: expand(editorCommand.command),
    args: editorCommand.args.map(expand),
  }
}

/**
 * Resolves a Windows command name (e.g. `code`) to its actual `.cmd`/`.bat`
 * path via `where`, so it can be spawned explicitly instead of through a shell.
 */
export function resolveWindowsCommandPath(
  command: string,
  dependencies: ExternalEditorDependencies,
): string | null {
  if (!isWindows) return null
  const result = dependencies.spawnSync('where', [command], {
    encoding: 'utf8',
  })
  if (result.status !== 0) return null
  const lines = String(result.stdout ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  return lines.find(line => /\.(cmd|bat)$/i.test(line)) ?? lines[0] ?? null
}

/**
 * Expands shell-style home aliases without invoking a shell, then resolves
 * Windows command shims when necessary.
 */
function normalizeParsedEditorCommand(
  parsed: EditorCommand,
  dependencies: ExternalEditorDependencies,
): EditorCommand {
  const expanded = expandEditorCommand(parsed)
  if (!isWindows) return expanded

  const isCommandShim =
    !extname(expanded.command) || /\.(cmd|bat)$/i.test(expanded.command)
  if (isCommandShim) {
    const resolved = resolveWindowsCommandPath(expanded.command, dependencies)
    if (resolved && /\.(cmd|bat)$/i.test(resolved)) {
      // `.cmd`/`.bat` shims cannot be spawned directly; route them through
      // the shell like the built-in `code` candidate does.
      return { ...expanded, command: resolved, shell: true }
    }
  }
  return expanded
}

function buildEditorCommandCandidates(
  dependencies: ExternalEditorDependencies,
): EditorCommand[] {
  const candidates: EditorCommand[] = []

  const envEditor = process.env.VISUAL || process.env.EDITOR
  if (envEditor?.trim()) {
    const parsed = parseExternalEditorCommand(envEditor)
    // A value that cannot be parsed safely (e.g. shell operators) must never
    // be executed; fall through to the built-in candidates instead.
    if (parsed) {
      candidates.push(normalizeParsedEditorCommand(parsed, dependencies))
    }
  }

  if (isWindows) {
    if (isCommandAvailable('code', dependencies)) {
      candidates.push({
        command: 'code',
        args: ['-w'],
        displayName: 'code -w',
        shell: isWindows, // Windows needs shell for code.cmd
      })
    }
    // notepad is always available on Windows
    candidates.push({
      command: 'notepad.exe',
      args: [],
      displayName: 'notepad',
    })
    return candidates
  }

  const unixCandidates: Array<[string, string[], string]> = [
    ['code', ['-w'], 'code -w'],
    ['nano', [], 'nano'],
    ['vim', [], 'vim'],
    ['open', ['-W', '-t'], 'open -W -t'],
  ]
  for (const [command, args, displayName] of unixCandidates) {
    if (isCommandAvailable(command, dependencies)) {
      candidates.push({ command, args, displayName })
    }
  }
  return candidates
}

export function getExternalEditorLabel(): string | null {
  return resolveEditorCommand(dependencyLoader())?.displayName ?? null
}

function restoreStdinState(previouslyRaw: boolean): void {
  if (!process.stdin.isTTY) return
  process.stdin.resume()
  if (previouslyRaw && process.stdin.setRawMode) {
    process.stdin.setRawMode(true)
  }
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

export type ExternalEditorResult =
  | { text: string; editorLabel: string }
  | { text: null; editorLabel?: string; error: Error }

function spawnEditor(
  dependencies: ExternalEditorDependencies,
  editorCommand: EditorCommand,
  filePath: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (editorCommand.shell) assertSafeShellFilePath(filePath)
    const child = dependencies.spawn(
      editorCommand.command,
      [...editorCommand.args, filePath],
      {
        stdio: 'inherit',
        shell: editorCommand.shell ?? false,
      },
    )

    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (code === 0 || code === null) {
        resolve()
      } else {
        reject(
          new Error(
            `Editor exited with code ${code}${signal ? ` (signal ${signal})` : ''}`,
          ),
        )
      }
    })
  })
}

function isSpawnNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

/**
 * Runs the editor command, falling back to the next candidate when the
 * configured command cannot be spawned (e.g. a stale `$EDITOR` path).
 */
async function launchWithFallback(
  dependencies: ExternalEditorDependencies,
  filePath: string,
): Promise<{ editorLabel: string }> {
  const editorCommands = buildEditorCommandCandidates(dependencies)
  if (editorCommands.length === 0) {
    throw new Error(
      'No editor found. Set $VISUAL or $EDITOR, or install code, nano, vim, or notepad.',
    )
  }

  let lastError: Error | null = null
  for (const editorCommand of editorCommands) {
    try {
      await spawnEditor(dependencies, editorCommand, filePath)
      return { editorLabel: editorCommand.displayName }
    } catch (error) {
      if (isSpawnNotFoundError(error)) {
        lastError = error as Error
        continue
      }
      throw error
    }
  }
  throw (
    lastError ??
    new Error(
      'No editor found. Set $VISUAL or $EDITOR, or install code, nano, vim, or notepad.',
    )
  )
}

export async function launchExternalEditor(
  initialText: string,
): Promise<ExternalEditorResult> {
  const dependencies = dependencyLoader()

  const dir = mkdtempSync(join(tmpdir(), 'kode-edit-'))
  const filePath = join(dir, 'message.txt')
  writeFileSync(filePath, initialText, { encoding: 'utf-8', mode: 0o600 })

  const wasRaw = Boolean(process.stdin.isTTY && process.stdin.isRaw)
  if (process.stdin.isTTY) {
    process.stdin.pause()
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(false)
    }
  }

  try {
    const { editorLabel } = await withSuspendedInk(dependencies, () =>
      launchWithFallback(dependencies, filePath),
    )
    restoreStdinState(wasRaw)
    const edited = normalizeNewlines(readFileSync(filePath, 'utf-8'))
    rmSync(dir, { recursive: true, force: true })
    return { text: edited, editorLabel }
  } catch (error) {
    restoreStdinState(wasRaw)
    rmSync(dir, { recursive: true, force: true })
    return {
      text: null,
      error: error as Error,
    }
  }
}

export type ExternalEditorFileResult =
  | { ok: true; editorLabel: string }
  | { ok: false; editorLabel?: string; error: Error }

export async function launchExternalEditorForFilePath(
  filePath: string,
): Promise<ExternalEditorFileResult> {
  const dependencies = dependencyLoader()

  const wasRaw = Boolean(process.stdin.isTTY && process.stdin.isRaw)
  if (process.stdin.isTTY) {
    process.stdin.pause()
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(false)
    }
  }

  try {
    const { editorLabel } = await withSuspendedInk(dependencies, () =>
      launchWithFallback(dependencies, filePath),
    )
    restoreStdinState(wasRaw)
    return { ok: true, editorLabel }
  } catch (error) {
    restoreStdinState(wasRaw)
    return {
      ok: false,
      error: error as Error,
    }
  }
}
