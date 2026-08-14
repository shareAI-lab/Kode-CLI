import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import type { Writable } from 'node:stream'

const ESC = '\u001b'
const BEL = '\u0007'
const ST = '\u001b\\'

const MAX_OSC52_SEQUENCE_BYTES = 100_000
const OSC52_HEADER = `${ESC}]52;c;`
const OSC52_FOOTER = BEL
const MAX_OSC52_BODY_B64_BYTES =
  MAX_OSC52_SEQUENCE_BYTES -
  Buffer.byteLength(OSC52_HEADER) -
  Buffer.byteLength(OSC52_FOOTER)
const MAX_OSC52_DATA_BYTES = Math.floor(MAX_OSC52_BODY_B64_BYTES / 4) * 3

const SCREEN_DCS_CHUNK_SIZE = 240

type TtyTarget = { stream: Writable; closeAfter: boolean } | null

export type CopyToClipboardMethod = 'osc52' | 'system'

export type CopyToClipboardResult = {
  method: CopyToClipboardMethod
  truncated: boolean
}

function inTmux(): boolean {
  return Boolean(
    process.env.TMUX || (process.env.TERM ?? '').startsWith('tmux'),
  )
}

function inScreen(): boolean {
  return Boolean(
    process.env.STY || (process.env.TERM ?? '').startsWith('screen'),
  )
}

function isSSH(): boolean {
  return Boolean(
    process.env.SSH_TTY || process.env.SSH_CONNECTION || process.env.SSH_CLIENT,
  )
}

function isWSL(): boolean {
  return Boolean(
    process.env.WSL_DISTRO_NAME ||
    process.env.WSLENV ||
    process.env.WSL_INTEROP,
  )
}

function isDumbTerm(): boolean {
  return (process.env.TERM ?? '') === 'dumb'
}

function shouldUseOsc52(tty: TtyTarget): boolean {
  return (
    Boolean(tty) &&
    !isDumbTerm() &&
    // Prefer OSC-52 when the process is running on a remote host (SSH),
    // where system clipboard tools would typically target the remote machine.
    isSSH()
  )
}

function safeUtf8Truncate(
  buf: Buffer,
  maxBytes: number,
): {
  buf: Buffer
  truncated: boolean
} {
  if (buf.length <= maxBytes) return { buf, truncated: false }
  let end = maxBytes
  while (end > 0 && (buf[end - 1]! & 0b1100_0000) === 0b1000_0000) end -= 1
  return { buf: buf.subarray(0, end), truncated: true }
}

function buildOsc52(text: string): { seq: string; truncated: boolean } {
  const raw = Buffer.from(text, 'utf8')
  const { buf: safe, truncated } = safeUtf8Truncate(raw, MAX_OSC52_DATA_BYTES)
  const b64 = safe.toString('base64')
  return { seq: `${OSC52_HEADER}${b64}${OSC52_FOOTER}`, truncated }
}

function wrapForTmux(seq: string): string {
  const doubledEsc = seq.split(ESC).join(ESC + ESC)
  return `${ESC}Ptmux;${doubledEsc}${ST}`
}

function wrapForScreen(seq: string): string {
  let out = ''
  for (let i = 0; i < seq.length; i += SCREEN_DCS_CHUNK_SIZE) {
    out += `${ESC}P${seq.slice(i, i + SCREEN_DCS_CHUNK_SIZE)}${ST}`
  }
  return out
}

async function writeAll(stream: Writable, data: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (err: unknown) => {
      cleanup()
      reject(err as Error)
    }
    const onDrain = () => {
      cleanup()
      resolve()
    }
    const cleanup = () => {
      stream.off('error', onError)
      stream.off('drain', onDrain)
    }

    stream.once('error', onError)
    if (stream.write(data)) {
      cleanup()
      resolve()
    } else {
      stream.once('drain', onDrain)
    }
  })
}

function pickTty(): TtyTarget {
  if (process.platform !== 'win32') {
    try {
      const devTty = fs.createWriteStream('/dev/tty')
      devTty.on('error', () => {})
      return { stream: devTty, closeAfter: true }
    } catch {
      // fall through
    }
  }

  return null
}

function isCommandAvailable(command: string): boolean {
  const checker = process.platform === 'win32' ? 'where' : 'which'
  const result = spawnSync(checker, [command], { stdio: 'ignore' })
  return result.status === 0
}

async function runClipboardCommand(args: {
  command: string
  commandArgs: string[]
  text: string
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(args.command, args.commandArgs, {
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
    })

    let stderr = ''
    const onStderr = (chunk: Buffer | string) => {
      if (stderr.length > 8_000) return
      stderr += chunk.toString()
    }

    child.on('error', reject)
    child.stderr?.on('data', onStderr)
    child.on('exit', code => {
      if (code === 0) {
        resolve()
        return
      }
      const message = stderr.trim() || `${args.command} exited ${String(code)}`
      reject(new Error(message))
    })

    child.stdin?.end(args.text, 'utf8')
  })
}

async function runClipboardReadCommand(args: {
  command: string
  commandArgs: string[]
}): Promise<string | null> {
  return await new Promise<string | null>(resolve => {
    const child = spawn(args.command, args.commandArgs, {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })

    let out = ''
    const onStdout = (chunk: Buffer | string) => {
      if (out.length >= 1_000_000) return
      out += chunk.toString('utf8')
    }

    child.on('error', () => resolve(null))
    child.stdout?.on('data', onStdout)
    child.on('exit', code => {
      resolve(code === 0 && out.trim() ? out : null)
    })
  })
}

/**
 * Reads the current clipboard text via the platform tool. Returns null when no
 * backend is available or the clipboard holds no text. Used as a fallback for
 * Ctrl+V in terminals that forward the keypress to the app (kitty, alacritty,
 * wezterm, ...) instead of pasting text themselves.
 */
export async function readTextFromClipboard(): Promise<string | null> {
  const candidates: { command: string; commandArgs: string[] }[] =
    process.platform === 'darwin'
      ? [{ command: 'pbpaste', commandArgs: [] }]
      : process.platform === 'win32'
        ? [
            {
              command: 'powershell',
              commandArgs: ['-NoProfile', '-Command', 'Get-Clipboard -Raw'],
            },
          ]
        : [
            { command: 'wl-paste', commandArgs: ['--no-newline'] },
            {
              command: 'xclip',
              commandArgs: ['-selection', 'clipboard', '-o'],
            },
            { command: 'xsel', commandArgs: ['--clipboard', '--output'] },
          ]

  for (const candidate of candidates) {
    if (!isCommandAvailable(candidate.command)) continue
    const result = await runClipboardReadCommand(candidate)
    if (result !== null) return result
  }
  return null
}

async function copyViaSystemClipboard(text: string): Promise<void> {
  if (process.platform === 'darwin') {
    await runClipboardCommand({ command: 'pbcopy', commandArgs: [], text })
    return
  }

  if (process.platform === 'win32') {
    await runClipboardCommand({ command: 'clip', commandArgs: [], text })
    return
  }

  if (isWSL() && isCommandAvailable('clip.exe')) {
    await runClipboardCommand({ command: 'clip.exe', commandArgs: [], text })
    return
  }

  if (isCommandAvailable('wl-copy')) {
    await runClipboardCommand({ command: 'wl-copy', commandArgs: [], text })
    return
  }

  if (isCommandAvailable('xclip')) {
    await runClipboardCommand({
      command: 'xclip',
      commandArgs: ['-selection', 'clipboard'],
      text,
    })
    return
  }

  if (isCommandAvailable('xsel')) {
    await runClipboardCommand({
      command: 'xsel',
      commandArgs: ['--clipboard', '--input'],
      text,
    })
    return
  }

  throw new Error(
    'No clipboard backend found. Install wl-copy (Wayland) or xclip/xsel (X11), or use a terminal that supports OSC 52.',
  )
}

export async function copyTextToClipboard(
  text: string,
): Promise<CopyToClipboardResult> {
  if (!text.trim()) return { method: 'system', truncated: false }

  const tty = pickTty()
  const canUseOsc52 = Boolean(tty) && !isDumbTerm()

  if (shouldUseOsc52(tty)) {
    const { seq: osc, truncated } = buildOsc52(text)
    const payload = inTmux()
      ? wrapForTmux(osc)
      : inScreen()
        ? wrapForScreen(osc)
        : osc

    await writeAll(tty!.stream, payload)
    if (tty!.closeAfter) {
      ;(tty!.stream as fs.WriteStream).end()
    }
    return { method: 'osc52', truncated }
  }

  try {
    await copyViaSystemClipboard(text)
    return { method: 'system', truncated: false }
  } catch (error) {
    if (!canUseOsc52) throw error

    const { seq: osc, truncated } = buildOsc52(text)
    const payload = inTmux()
      ? wrapForTmux(osc)
      : inScreen()
        ? wrapForScreen(osc)
        : osc

    await writeAll(tty!.stream, payload)
    if (tty!.closeAfter) {
      ;(tty!.stream as fs.WriteStream).end()
    }
    return { method: 'osc52', truncated }
  }
}
