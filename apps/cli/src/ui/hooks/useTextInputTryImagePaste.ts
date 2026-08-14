import type { Cursor } from '#cli-utils/Cursor'
import { readTextFromClipboard } from '#cli-utils/clipboard'
import {
  CLIPBOARD_ERROR_MESSAGE,
  getImageFromClipboard,
  getImageFromClipboardAsync,
} from '#core/utils/imagePaste'
import type { ClipboardImage } from '#core/utils/image/media'

const IMAGE_PLACEHOLDER = '[Image pasted]'
const IMAGE_PASTE_FAILED_MESSAGE =
  'Unable to paste the image. Copy it again and retry.'

export function tryImagePaste({
  cursor,
  mask,
  onImagePaste,
  onMessage,
  clearImagePasteErrorTimeout,
  scheduleImagePasteErrorClear,
}: {
  cursor: Cursor
  mask: string
  onImagePaste?: (image: ClipboardImage) => string | void
  onMessage?: (show: boolean, message?: string) => void
  clearImagePasteErrorTimeout: () => void
  scheduleImagePasteErrorClear: () => void
}): Cursor {
  if (mask) {
    return cursor
  }

  const image = getImageFromClipboard()
  if (image === null) {
    onMessage?.(true, CLIPBOARD_ERROR_MESSAGE)
    clearImagePasteErrorTimeout()
    scheduleImagePasteErrorClear()
    return cursor
  }

  const placeholder = onImagePaste?.(image)
  return cursor.insert(
    typeof placeholder === 'string' ? placeholder : IMAGE_PLACEHOLDER,
  )
}

export async function resolveImagePastePlaceholder({
  mask,
  onImagePaste,
  onMessage,
  clearImagePasteErrorTimeout,
  scheduleImagePasteErrorClear,
}: {
  mask: string
  onImagePaste?: (image: ClipboardImage) => string | void
  onMessage?: (show: boolean, message?: string) => void
  clearImagePasteErrorTimeout: () => void
  scheduleImagePasteErrorClear: () => void
}): Promise<string | null> {
  if (mask) {
    return null
  }

  onMessage?.(true, 'Reading image from clipboard...')
  try {
    const image = await getImageFromClipboardAsync()
    if (image !== null) {
      onMessage?.(false)
      const placeholder = onImagePaste?.(image)
      return typeof placeholder === 'string' ? placeholder : IMAGE_PLACEHOLDER
    }

    // No image in the clipboard. On terminals that forward Ctrl+V to the app
    // (kitty, alacritty, wezterm, ...) the user's intent is a text paste, so
    // insert clipboard text instead of failing with an image error. macOS is
    // excluded: Cmd+V already pastes text there and Ctrl+V stays image-only.
    if (process.platform !== 'darwin') {
      const text = await readTextFromClipboard()
      if (text) {
        onMessage?.(false)
        return text
      }
    }

    onMessage?.(true, CLIPBOARD_ERROR_MESSAGE)
    clearImagePasteErrorTimeout()
    scheduleImagePasteErrorClear()
    return null
  } catch {
    onMessage?.(true, IMAGE_PASTE_FAILED_MESSAGE)
    clearImagePasteErrorTimeout()
    scheduleImagePasteErrorClear()
    return null
  }
}
