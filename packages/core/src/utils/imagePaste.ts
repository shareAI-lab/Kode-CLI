import { execFile, execFileSync } from 'child_process'
import { readFileSync, unlinkSync } from 'fs'
import { readFile, unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { debug as debugLogger } from '#core/utils/debugLogger'
import {
  detectImageMediaType,
  normalizeSupportedImageMediaType,
  type ClipboardImage,
  type SupportedImageMediaType,
} from '#core/utils/image/media'

const CLIPBOARD_MAX_IMAGE_BYTES = 20 * 1024 * 1024
const WINDOWS_CLIPBOARD_OUTPUT_MARGIN_BYTES = 4 * 1024
const WINDOWS_CLIPBOARD_MAX_BUFFER =
  getBase64EncodedLength(CLIPBOARD_MAX_IMAGE_BYTES) +
  WINDOWS_CLIPBOARD_OUTPUT_MARGIN_BYTES
const execFileAsync = promisify(execFile)

const DEFAULT_CLIPBOARD_ERROR_MESSAGE =
  'No compatible image found in clipboard. Copy a PNG, JPEG, GIF, or WebP image; on Linux install wl-paste or xclip.'
const WINDOWS_CLIPBOARD_ERROR_MESSAGES = {
  no_image: 'No image found in clipboard. Copy an image and try again.',
  unsupported_format:
    'Clipboard image format is not supported. Copy a PNG, JPEG, GIF, or WebP image.',
  output_too_large: 'Clipboard image exceeds the 20 MiB size limit.',
  read_failed:
    'Failed to read the image from the Windows clipboard. Copy it again and retry.',
} as const

export let CLIPBOARD_ERROR_MESSAGE = DEFAULT_CLIPBOARD_ERROR_MESSAGE

type WindowsClipboardFailureKind = keyof typeof WINDOWS_CLIPBOARD_ERROR_MESSAGES

type WindowsClipboardReadResult =
  | { ok: true; image: ClipboardImage }
  | {
      ok: false
      kind: WindowsClipboardFailureKind
      error?: unknown
      imageBytes?: number
    }

const WINDOWS_CLIPBOARD_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$maxImageBytes = ${CLIPBOARD_MAX_IMAGE_BYTES}

$files = [System.Windows.Forms.Clipboard]::GetFileDropList()
if ($files -and $files.Count -gt 0) {
  $path = [string]$files[0]
  if ([System.IO.File]::Exists($path)) {
    if ((Get-Item -LiteralPath $path).Length -gt $maxImageBytes) {
      exit 3
    }
    [Console]::Out.Write([Convert]::ToBase64String([System.IO.File]::ReadAllBytes($path)))
    exit 0
  }
}

$image = [System.Windows.Forms.Clipboard]::GetImage()
if ($null -eq $image) {
  exit 2
}

$stream = New-Object System.IO.MemoryStream
try {
  $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  if ($stream.Length -gt $maxImageBytes) {
    exit 3
  }
  [Console]::Out.Write([Convert]::ToBase64String($stream.ToArray()))
} finally {
  $stream.Dispose()
  $image.Dispose()
}
`

export function getImageFromClipboard(): ClipboardImage | null {
  switch (process.platform) {
    case 'darwin':
      return getImageFromMacClipboard()
    case 'win32':
      return getImageFromWindowsClipboard()
    case 'linux':
      return getImageFromLinuxClipboard()
    default:
      return null
  }
}

export async function getImageFromClipboardAsync(): Promise<ClipboardImage | null> {
  switch (process.platform) {
    case 'darwin':
      return getImageFromMacClipboardAsync()
    case 'win32':
      return getImageFromWindowsClipboardAsync()
    case 'linux':
      return getImageFromLinuxClipboardAsync()
    default:
      return null
  }
}

async function execFileText(
  command: string,
  args: string[],
  options: Record<string, unknown>,
): Promise<string> {
  const { stdout } = await execFileAsync(command, args, options as never)
  return typeof stdout === 'string' ? stdout : stdout.toString('utf8')
}

async function execFileBuffer(
  command: string,
  args: string[],
  options: Record<string, unknown>,
): Promise<Buffer> {
  const { stdout } = await execFileAsync(command, args, {
    ...options,
    encoding: 'buffer',
  } as never)
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout)
}

function getImageFromMacClipboard(): ClipboardImage | null {
  const screenshotPath = join(
    tmpdir(),
    `kode-cli-clipboard-${process.pid}-${Date.now()}.png`,
  )

  try {
    execFileSync(
      'osascript',
      [
        '-e',
        'set png_data to (the clipboard as \u00abclass PNGf\u00bb)',
        '-e',
        `set fp to open for access POSIX file "${escapeAppleScriptString(
          screenshotPath,
        )}" with write permission`,
        '-e',
        'write png_data to fp',
        '-e',
        'close access fp',
      ],
      { stdio: 'ignore', timeout: 3000 },
    )

    const imageBuffer = readFileSync(screenshotPath)
    return imageFromBuffer(imageBuffer)
  } catch {
    return null
  } finally {
    try {
      unlinkSync(screenshotPath)
    } catch {
      /* no-op */
    }
  }
}

async function getImageFromMacClipboardAsync(): Promise<ClipboardImage | null> {
  const screenshotPath = join(
    tmpdir(),
    `kode-cli-clipboard-${process.pid}-${Date.now()}.png`,
  )

  try {
    await execFileAsync(
      'osascript',
      [
        '-e',
        'set png_data to (the clipboard as \u00abclass PNGf\u00bb)',
        '-e',
        `set fp to open for access POSIX file "${escapeAppleScriptString(
          screenshotPath,
        )}" with write permission`,
        '-e',
        'write png_data to fp',
        '-e',
        'close access fp',
      ],
      { stdio: 'ignore', timeout: 3000 } as never,
    )

    const imageBuffer = await readFile(screenshotPath)
    return imageFromBuffer(imageBuffer)
  } catch {
    return null
  } finally {
    try {
      await unlink(screenshotPath)
    } catch {
      /* no-op */
    }
  }
}

function getImageFromWindowsClipboard(): ClipboardImage | null {
  CLIPBOARD_ERROR_MESSAGE = DEFAULT_CLIPBOARD_ERROR_MESSAGE

  try {
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-Command',
        WINDOWS_CLIPBOARD_SCRIPT,
      ],
      {
        encoding: 'utf8',
        maxBuffer: WINDOWS_CLIPBOARD_MAX_BUFFER,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      },
    )

    return finishWindowsClipboardRead(parseWindowsClipboardOutput(output))
  } catch (error) {
    return finishWindowsClipboardRead({
      ok: false,
      kind: classifyWindowsClipboardError(error),
      error,
    })
  }
}

async function getImageFromWindowsClipboardAsync(): Promise<ClipboardImage | null> {
  CLIPBOARD_ERROR_MESSAGE = DEFAULT_CLIPBOARD_ERROR_MESSAGE

  try {
    const output = await execFileText(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-Command',
        WINDOWS_CLIPBOARD_SCRIPT,
      ],
      {
        encoding: 'utf8',
        maxBuffer: WINDOWS_CLIPBOARD_MAX_BUFFER,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      },
    )

    return finishWindowsClipboardRead(parseWindowsClipboardOutput(output))
  } catch (error) {
    return finishWindowsClipboardRead({
      ok: false,
      kind: classifyWindowsClipboardError(error),
      error,
    })
  }
}

function getImageFromLinuxClipboard(): ClipboardImage | null {
  return getImageFromWlPaste() ?? getImageFromXclip()
}

async function getImageFromLinuxClipboardAsync(): Promise<ClipboardImage | null> {
  return (await getImageFromWlPasteAsync()) ?? (await getImageFromXclipAsync())
}

function getImageFromWlPaste(): ClipboardImage | null {
  try {
    const types = execFileSync('wl-paste', ['--list-types'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/)
      .filter(Boolean)

    const picked = pickClipboardMimeType(types)
    if (!picked) {
      return null
    }

    const buffer = execFileSync(
      'wl-paste',
      ['--no-newline', '--type', picked.target],
      {
        maxBuffer: CLIPBOARD_MAX_IMAGE_BYTES,
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )
    return imageFromBuffer(buffer)
  } catch {
    return null
  }
}

async function getImageFromWlPasteAsync(): Promise<ClipboardImage | null> {
  try {
    const types = (
      await execFileText('wl-paste', ['--list-types'], {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    )
      .split(/\r?\n/)
      .filter(Boolean)

    const picked = pickClipboardMimeType(types)
    if (!picked) {
      return null
    }

    const buffer = await execFileBuffer(
      'wl-paste',
      ['--no-newline', '--type', picked.target],
      {
        maxBuffer: CLIPBOARD_MAX_IMAGE_BYTES,
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )
    return imageFromBuffer(buffer)
  } catch {
    return null
  }
}

function getImageFromXclip(): ClipboardImage | null {
  try {
    const targets = execFileSync(
      'xclip',
      ['-selection', 'clipboard', '-t', 'TARGETS', '-o'],
      {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )
      .split(/\r?\n/)
      .filter(Boolean)

    const picked = pickClipboardMimeType(targets)
    if (!picked) {
      return null
    }

    const buffer = execFileSync(
      'xclip',
      ['-selection', 'clipboard', '-t', picked.target, '-o'],
      {
        maxBuffer: CLIPBOARD_MAX_IMAGE_BYTES,
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )
    return imageFromBuffer(buffer)
  } catch {
    return null
  }
}

async function getImageFromXclipAsync(): Promise<ClipboardImage | null> {
  try {
    const targets = (
      await execFileText(
        'xclip',
        ['-selection', 'clipboard', '-t', 'TARGETS', '-o'],
        {
          encoding: 'utf8',
          timeout: 3000,
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      )
    )
      .split(/\r?\n/)
      .filter(Boolean)

    const picked = pickClipboardMimeType(targets)
    if (!picked) {
      return null
    }

    const buffer = await execFileBuffer(
      'xclip',
      ['-selection', 'clipboard', '-t', picked.target, '-o'],
      {
        maxBuffer: CLIPBOARD_MAX_IMAGE_BYTES,
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    )
    return imageFromBuffer(buffer)
  } catch {
    return null
  }
}

function imageFromBuffer(buffer: Buffer): ClipboardImage | null {
  const mediaType = detectImageMediaType(buffer)
  if (!mediaType) {
    return null
  }

  return {
    data: buffer.toString('base64'),
    mediaType,
  }
}

function pickClipboardMimeType(
  types: string[],
): { target: string; mediaType: SupportedImageMediaType } | null {
  for (const target of types) {
    const mediaType = normalizeSupportedImageMediaType(target)
    if (mediaType) {
      return { target, mediaType }
    }
  }
  return null
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function getBase64EncodedLength(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4
}

function parseWindowsClipboardOutput(
  output: string,
  maxImageBytes = CLIPBOARD_MAX_IMAGE_BYTES,
): WindowsClipboardReadResult {
  const base64 = output.trim()
  if (!base64) {
    return { ok: false, kind: 'read_failed' }
  }

  const imageBuffer = Buffer.from(base64, 'base64')
  if (imageBuffer.length > maxImageBytes) {
    return {
      ok: false,
      kind: 'output_too_large',
      imageBytes: imageBuffer.length,
    }
  }

  const image = imageFromBuffer(imageBuffer)
  if (!image) {
    return {
      ok: false,
      kind: 'unsupported_format',
      imageBytes: imageBuffer.length,
    }
  }

  return { ok: true, image }
}

function classifyWindowsClipboardError(
  error: unknown,
): Exclude<WindowsClipboardFailureKind, 'unsupported_format'> {
  const errorLike = asErrorLike(error)
  if (errorLike.status === 2 || errorLike.code === 2) {
    return 'no_image'
  }
  if (errorLike.status === 3 || errorLike.code === 3) {
    return 'output_too_large'
  }
  if (
    errorLike.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
    errorLike.code === 'ENOBUFS' ||
    errorLike.message?.toLowerCase().includes('maxbuffer')
  ) {
    return 'output_too_large'
  }
  return 'read_failed'
}

function finishWindowsClipboardRead(
  result: WindowsClipboardReadResult,
): ClipboardImage | null {
  if (result.ok === true) {
    return result.image
  }

  CLIPBOARD_ERROR_MESSAGE = WINDOWS_CLIPBOARD_ERROR_MESSAGES[result.kind]

  if (result.kind === 'output_too_large' || result.kind === 'read_failed') {
    debugLogger.warn('WINDOWS_CLIPBOARD_IMAGE_READ_FAILED', {
      kind: result.kind,
      imageBytes: result.imageBytes,
      maxImageBytes: CLIPBOARD_MAX_IMAGE_BYTES,
      maxBufferBytes: WINDOWS_CLIPBOARD_MAX_BUFFER,
      error: describeError(result.error),
    })
  }

  return null
}

function asErrorLike(error: unknown): {
  code?: unknown
  status?: unknown
  message?: string
} {
  if (typeof error !== 'object' || error === null) {
    return {}
  }

  const errorLike = error as {
    code?: unknown
    status?: unknown
    message?: unknown
  }
  return {
    code: errorLike.code,
    status: errorLike.status,
    message:
      typeof errorLike.message === 'string' ? errorLike.message : undefined,
  }
}

function describeError(error: unknown): Record<string, unknown> | undefined {
  if (error === undefined) {
    return undefined
  }

  const errorLike = asErrorLike(error)
  return {
    name:
      error instanceof Error
        ? error.name
        : typeof error === 'object' && error !== null && 'name' in error
          ? String(error.name)
          : undefined,
    code: errorLike.code,
    status: errorLike.status,
    message: errorLike.message ?? String(error),
  }
}

export const __imagePasteInternalsForTests = {
  maxImageBytes: CLIPBOARD_MAX_IMAGE_BYTES,
  windowsClipboardMaxBuffer: WINDOWS_CLIPBOARD_MAX_BUFFER,
  windowsClipboardOutputMarginBytes: WINDOWS_CLIPBOARD_OUTPUT_MARGIN_BYTES,
  getBase64EncodedLength,
  parseWindowsClipboardOutput,
  classifyWindowsClipboardError,
  getWindowsClipboardErrorMessage: (kind: WindowsClipboardFailureKind) =>
    WINDOWS_CLIPBOARD_ERROR_MESSAGES[kind],
  applyWindowsClipboardFailure: (kind: WindowsClipboardFailureKind) =>
    finishWindowsClipboardRead({ ok: false, kind }),
  resetClipboardErrorMessage: () => {
    CLIPBOARD_ERROR_MESSAGE = DEFAULT_CLIPBOARD_ERROR_MESSAGE
  },
}
