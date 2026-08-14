import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  __setExternalEditorDependencyLoaderForTests,
  launchExternalEditor,
  launchExternalEditorForFilePath,
  parseExternalEditorCommand,
  type ExternalEditorDependencies,
} from './externalEditor'

const lifecycle: string[] = []

let exitCode: number | null = 0
let spawnError: Error | null = null
let fakeStdin: FakeTTYInput
let lastSpawn:
  | { command: string; args: string[]; shell: boolean; fileMode: number | null }
  | undefined

const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin')
const originalStdout = Object.getOwnPropertyDescriptor(process, 'stdout')
const originalEditor = process.env.EDITOR
const originalVisual = process.env.VISUAL
const originalScreenReader = process.env.SCREENREADER
const originalKodeScreenReader = process.env.KODE_SCREEN_READER

class FakeTTYInput {
  isTTY = true
  isRaw: boolean

  constructor(isRaw: boolean) {
    this.isRaw = isRaw
  }

  pause(): void {
    lifecycle.push('stdin.pause')
  }

  resume(): void {
    lifecycle.push('stdin.resume')
  }

  setRawMode(value: boolean): void {
    this.isRaw = value
    lifecycle.push(`stdin.raw:${value}`)
  }
}

function installFakeTty({ isRaw = true }: { isRaw?: boolean } = {}): void {
  fakeStdin = new FakeTTYInput(isRaw)
  Object.defineProperty(process, 'stdin', {
    configurable: true,
    value: fakeStdin,
  })
  Object.defineProperty(process, 'stdout', {
    configurable: true,
    value: { isTTY: true },
  })
}

function restoreProcessState(): void {
  if (originalStdin) Object.defineProperty(process, 'stdin', originalStdin)
  if (originalStdout) Object.defineProperty(process, 'stdout', originalStdout)
  if (originalEditor === undefined) delete process.env.EDITOR
  else process.env.EDITOR = originalEditor
  if (originalVisual === undefined) delete process.env.VISUAL
  else process.env.VISUAL = originalVisual
  if (originalScreenReader === undefined) delete process.env.SCREENREADER
  else process.env.SCREENREADER = originalScreenReader
  if (originalKodeScreenReader === undefined)
    delete process.env.KODE_SCREEN_READER
  else process.env.KODE_SCREEN_READER = originalKodeScreenReader
}

function createFakeDependencies(): ExternalEditorDependencies {
  const dependencies = {
    spawnSync: () => ({ status: 0 }),
    spawn: (command: string, args: string[], options?: { shell?: boolean }) => {
      const filePath = args.at(-1)
      let fileMode: number | null = null
      try {
        if (filePath) fileMode = statSync(filePath).mode & 0o777
      } catch {
        // Some tests deliberately pass a path that does not exist.
      }
      lastSpawn = {
        command,
        args,
        shell: options?.shell === true,
        fileMode,
      }
      lifecycle.push(`spawn:${command}`)
      lifecycle.push(`spawn.raw:${fakeStdin?.isRaw ?? false}`)
      lifecycle.push(`spawn.file:${args.at(-1) ?? ''}`)

      const child = new EventEmitter()
      if (spawnError) {
        const errorToEmit = spawnError
        spawnError = null
        queueMicrotask(() => child.emit('error', errorToEmit))
      } else {
        queueMicrotask(() => child.emit('exit', exitCode, null))
      }
      return child
    },
    writeToStdout: (chunk: Uint8Array | string, callback?: () => void) => {
      lifecycle.push(`stdout:${String(chunk)}`)
      callback?.()
      return true
    },
    enableLineWrapping: () => lifecycle.push('lineWrapping.enable'),
    disableLineWrapping: () => lifecycle.push('lineWrapping.disable'),
    suspendMouseEvents: () => lifecycle.push('mouse.suspend'),
    resumeMouseEvents: () => lifecycle.push('mouse.resume'),
    withEphemeralAlternateScreen: async <T>(fn: () => Promise<T> | T) => {
      lifecycle.push('alternateScreen.enter')
      try {
        return await fn()
      } finally {
        lifecycle.push('alternateScreen.exit')
      }
    },
    getInkInstanceForStdout: () => ({
      pause: () => lifecycle.push('ink.pause'),
      resume: () => lifecycle.push('ink.resume'),
      suspendStdin: () => lifecycle.push('ink.suspendStdin'),
      resumeStdin: () => lifecycle.push('ink.resumeStdin'),
    }),
    terminalCapabilityManager: {
      disableAllModes: () => lifecycle.push('terminalModes.disable'),
      enableSupportedModes: () => lifecycle.push('terminalModes.enable'),
    },
  }

  return dependencies as unknown as ExternalEditorDependencies
}

beforeEach(() => {
  lifecycle.length = 0
  exitCode = 0
  spawnError = null
  lastSpawn = undefined
  installFakeTty({ isRaw: true })
  process.env.EDITOR = 'test-editor'
  delete process.env.VISUAL
  delete process.env.SCREENREADER
  delete process.env.KODE_SCREEN_READER
  __setExternalEditorDependencyLoaderForTests(createFakeDependencies)
})

afterEach(() => {
  exitCode = 0
  spawnError = null
  __setExternalEditorDependencyLoaderForTests(null)
})

afterAll(() => {
  restoreProcessState()
})

describe('external editor terminal suspension', () => {
  test('launchExternalEditor owns Ink and terminal mode restore around the child editor', async () => {
    const result = await launchExternalEditor('draft')

    expect(result).toEqual({
      text: 'draft',
      editorLabel: 'test-editor',
    })
    expect(fakeStdin.isRaw).toBe(true)
    expect(lastSpawn?.shell).toBe(false)
    if (process.platform !== 'win32') expect(lastSpawn?.fileMode).toBe(0o600)
    expect(lifecycle).toEqual([
      'stdin.pause',
      'stdin.raw:false',
      'ink.pause',
      'ink.suspendStdin',
      'terminalModes.disable',
      'mouse.suspend',
      'lineWrapping.enable',
      'stdout:\x1b[0m\x1b[?25h',
      'alternateScreen.enter',
      'spawn:test-editor',
      'spawn.raw:false',
      expect.stringMatching(/^spawn\.file:.*message\.txt$/),
      'alternateScreen.exit',
      'stdout:\x1b[?25l',
      'lineWrapping.disable',
      'terminalModes.enable',
      'mouse.resume',
      'ink.resumeStdin',
      'ink.resume',
      'stdin.resume',
      'stdin.raw:true',
    ])
  })

  test('parses editor flags without invoking a shell', async () => {
    process.env.EDITOR = 'test-editor --wait --reuse-window'

    const result = await launchExternalEditor('draft')

    expect(result.text).toBe('draft')
    expect(lastSpawn).toMatchObject({
      command: 'test-editor',
      shell: false,
    })
    expect(lastSpawn?.args.slice(0, -1)).toEqual(['--wait', '--reuse-window'])
  })

  test('rejects shell operators without executing them and falls back to a safe editor', async () => {
    process.env.EDITOR = 'test-editor; unexpected-command'

    const result = await launchExternalEditor('draft')

    // The unsafe command line is never spawned; the built-in candidate is used.
    expect(result.text).toBe('draft')
    expect(lifecycle.some(entry => entry.startsWith('spawn:test-editor'))).toBe(
      false,
    )
    expect(lastSpawn?.command).toBe('code')
  })

  test('expands ~ and $HOME in a configured editor command', async () => {
    process.env.EDITOR = '~/bin/editor --wait'

    const result = await launchExternalEditor('draft')

    expect(result.text).toBe('draft')
    expect(lastSpawn).toMatchObject({
      command: join(homedir(), 'bin', 'editor'),
      shell: false,
    })
    expect(lastSpawn?.args.slice(0, -1)).toEqual(['--wait'])

    process.env.EDITOR = '$HOME/bin/editor'
    await launchExternalEditor('draft')
    expect(lastSpawn?.command).toBe(join(homedir(), 'bin', 'editor'))
  })

  test('falls back to built-in editors when the configured command cannot spawn', async () => {
    process.env.EDITOR = 'missing-editor'
    spawnError = Object.assign(new Error('spawn missing-editor ENOENT'), {
      code: 'ENOENT',
    })

    const result = await launchExternalEditor('draft')

    expect(result.text).toBe('draft')
    expect(lastSpawn?.command).toBe('code')
  })

  test('does not retry other editors when the spawned editor fails', async () => {
    process.env.EDITOR = 'test-editor'
    exitCode = 1

    const result = await launchExternalEditor('draft')

    expect(result.text).toBeNull()
    expect(lastSpawn?.command).toBe('test-editor')
  })

  test('parses quoted Unix and Windows editor paths', () => {
    expect(
      parseExternalEditorCommand(
        '"/opt/My Editor/bin/editor" --wait',
        'darwin',
      ),
    ).toMatchObject({
      command: '/opt/My Editor/bin/editor',
      args: ['--wait'],
    })
    expect(
      parseExternalEditorCommand(
        '"C:\\Program Files\\Editor\\editor.exe" --wait',
        'win32',
      ),
    ).toMatchObject({
      command: 'C:\\Program Files\\Editor\\editor.exe',
      args: ['--wait'],
    })
  })

  test('launchExternalEditorForFilePath restores terminal state when editor exits non-zero', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kode-editor-test-'))
    const filePath = join(dir, 'output.txt')
    writeFileSync(filePath, 'content', 'utf8')
    exitCode = 2

    try {
      const result = await launchExternalEditorForFilePath(filePath)

      expect(result.ok).toBe(false)
      expect(fakeStdin.isRaw).toBe(true)
      expect(lifecycle).toContain('terminalModes.disable')
      expect(lifecycle).toContain('terminalModes.enable')
      expect(lifecycle.at(-2)).toBe('stdin.resume')
      expect(lifecycle.at(-1)).toBe('stdin.raw:true')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
