import { execFileSync } from 'child_process'
import { readFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  detectImageMediaType,
  normalizeSupportedImageMediaType,
  type ClipboardImage,
  type SupportedImageMediaType,
} from '@utils/image/media'

const CLIPBOARD_MAX_BUFFER = 20 * 1024 * 1024

export const CLIPBOARD_ERROR_MESSAGE =
  'No compatible image found in clipboard. Copy a PNG, JPEG, GIF, or WebP image; on Linux install wl-paste or xclip.'

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
        'set png_data to (the clipboard as «class PNGf»)',
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
    } catch {}
  }
}

function getImageFromWindowsClipboard(): ClipboardImage | null {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$files = [System.Windows.Forms.Clipboard]::GetFileDropList()
if ($files -and $files.Count -gt 0) {
  $path = [string]$files[0]
  if ([System.IO.File]::Exists($path)) {
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
  [Console]::Out.Write([Convert]::ToBase64String($stream.ToArray()))
} finally {
  $stream.Dispose()
  $image.Dispose()
}
`

  try {
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      {
        encoding: 'utf8',
        maxBuffer: CLIPBOARD_MAX_BUFFER,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      },
    ).trim()

    if (!output) {
      return null
    }

    return imageFromBuffer(Buffer.from(output, 'base64'))
  } catch {
    return null
  }
}

function getImageFromLinuxClipboard(): ClipboardImage | null {
  return getImageFromWlPaste() ?? getImageFromXclip()
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
        maxBuffer: CLIPBOARD_MAX_BUFFER,
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
        maxBuffer: CLIPBOARD_MAX_BUFFER,
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
