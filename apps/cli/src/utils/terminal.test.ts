import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'

const writes: string[] = []

const ENABLE_MOUSE_EVENTS_SEQUENCE = '\x1b[?1006h\x1b[?1000h'
const DISABLE_MOUSE_EVENTS_SEQUENCE =
  '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l'

let originalStdin: PropertyDescriptor | undefined
let originalStdout: PropertyDescriptor | undefined
let originalKodeTuiMouse: string | undefined
let terminal: typeof import('./terminal') | null = null

function captureWrite(
  chunk: Uint8Array | string,
  encodingOrCallback?:
    BufferEncoding | ((err?: NodeJS.ErrnoException | null) => void),
  callback?: (err?: NodeJS.ErrnoException | null) => void,
): boolean {
  writes.push(
    typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'),
  )
  const cb =
    typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
  cb?.()
  return true
}

function installFakeTty(): void {
  Object.defineProperty(process, 'stdin', {
    configurable: true,
    value: { isTTY: true },
  })
  Object.defineProperty(process, 'stdout', {
    configurable: true,
    value: { isTTY: true, write: captureWrite },
  })
}

function restoreTty(): void {
  if (originalStdin) Object.defineProperty(process, 'stdin', originalStdin)
  if (originalStdout) Object.defineProperty(process, 'stdout', originalStdout)
}

function resetMouseState(): void {
  if (!terminal) return
  terminal.resumeMouseEvents()
  for (let i = 0; i < 5; i += 1) {
    terminal.disableMouseEvents()
  }
}

beforeAll(async () => {
  originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin')
  originalStdout = Object.getOwnPropertyDescriptor(process, 'stdout')
  originalKodeTuiMouse = process.env.KODE_TUI_MOUSE
  installFakeTty()
  terminal = await import('./terminal')
  terminal.__setTerminalWriteToStdoutLoaderForTests(
    () => captureWrite as typeof import('#cli-utils/stdio').writeToStdout,
  )
})

beforeEach(() => {
  installFakeTty()
  terminal!.__setTerminalWriteToStdoutLoaderForTests(
    () => captureWrite as typeof import('#cli-utils/stdio').writeToStdout,
  )
  if (originalKodeTuiMouse === undefined) {
    delete process.env.KODE_TUI_MOUSE
  } else {
    process.env.KODE_TUI_MOUSE = originalKodeTuiMouse
  }
  resetMouseState()
  writes.length = 0
})

afterAll(() => {
  resetMouseState()
  terminal?.__setTerminalWriteToStdoutLoaderForTests(null)
  if (originalKodeTuiMouse === undefined) {
    delete process.env.KODE_TUI_MOUSE
  } else {
    process.env.KODE_TUI_MOUSE = originalKodeTuiMouse
  }
  restoreTty()
})

describe('terminal mouse tracking lifecycle', () => {
  test('suspends active mouse tracking without changing subscription count', () => {
    expect(terminal).not.toBeNull()

    terminal!.enableMouseEvents()
    terminal!.enableMouseEvents()
    terminal!.suspendMouseEvents()
    terminal!.suspendMouseEvents()
    terminal!.disableMouseEvents()
    terminal!.resumeMouseEvents()
    terminal!.disableMouseEvents()

    expect(writes).toEqual([
      ENABLE_MOUSE_EVENTS_SEQUENCE,
      DISABLE_MOUSE_EVENTS_SEQUENCE,
      ENABLE_MOUSE_EVENTS_SEQUENCE,
      DISABLE_MOUSE_EVENTS_SEQUENCE,
    ])
  })

  test('does not resume mouse tracking after all subscribers leave while suspended', () => {
    expect(terminal).not.toBeNull()

    terminal!.enableMouseEvents()
    terminal!.suspendMouseEvents()
    terminal!.disableMouseEvents()
    terminal!.resumeMouseEvents()

    expect(writes).toEqual([
      ENABLE_MOUSE_EVENTS_SEQUENCE,
      DISABLE_MOUSE_EVENTS_SEQUENCE,
    ])
  })

  test('force resets nested mouse tracking for process shutdown cleanup', () => {
    expect(terminal).not.toBeNull()

    terminal!.enableMouseEvents()
    terminal!.enableMouseEvents()
    terminal!.resetMouseEvents()
    terminal!.disableMouseEvents()
    terminal!.resumeMouseEvents()
    terminal!.enableMouseEvents()
    terminal!.disableMouseEvents()

    expect(writes).toEqual([
      ENABLE_MOUSE_EVENTS_SEQUENCE,
      DISABLE_MOUSE_EVENTS_SEQUENCE,
      ENABLE_MOUSE_EVENTS_SEQUENCE,
      DISABLE_MOUSE_EVENTS_SEQUENCE,
    ])
  })

  test('honors KODE_TUI_MOUSE=0 as a terminal tracking opt-out', () => {
    expect(terminal).not.toBeNull()

    process.env.KODE_TUI_MOUSE = '0'

    terminal!.enableMouseEvents()
    terminal!.suspendMouseEvents()
    terminal!.resumeMouseEvents()
    terminal!.disableMouseEvents()

    expect(terminal!.isMouseEventsEnabled()).toBe(false)
    expect(writes).toEqual([])
  })
})
