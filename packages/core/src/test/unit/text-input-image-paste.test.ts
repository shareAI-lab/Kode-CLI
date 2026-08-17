import { describe, expect, mock, test } from 'bun:test'

describe('text input image paste', () => {
  test('empty clipboard schedules image paste error cleanup', async () => {
    try {
      mock.module('#core/utils/imagePaste', () => ({
        CLIPBOARD_ERROR_MESSAGE: 'Clipboard does not contain an image',
        getImageFromClipboard: (): null => null,
        getImageFromClipboardAsync: async (): Promise<null> => null,
      }))
      mock.module('#cli-utils/clipboard', () => ({
        readTextFromClipboard: async (): Promise<null> => null,
      }))

      const { resolveImagePastePlaceholder } =
        await import('#ui-ink/hooks/useTextInputTryImagePaste')

      const messages: Array<{ show: boolean; message?: string }> = []
      let clearCount = 0
      let scheduleCount = 0

      const placeholder = await resolveImagePastePlaceholder({
        mask: '',
        onMessage: (show, message) => {
          messages.push({ show, message })
        },
        clearImagePasteErrorTimeout: () => {
          clearCount += 1
        },
        scheduleImagePasteErrorClear: () => {
          scheduleCount += 1
        },
      })

      expect(placeholder).toBeNull()
      expect(messages).toEqual([
        { show: true, message: 'Reading image from clipboard...' },
        { show: true, message: 'Clipboard does not contain an image' },
      ])
      expect(clearCount).toBe(1)
      expect(scheduleCount).toBe(1)
    } finally {
      mock.restore()
    }
  })

  test('reports a recoverable error when staging a pasted image fails', async () => {
    try {
      mock.module('#core/utils/imagePaste', () => ({
        CLIPBOARD_ERROR_MESSAGE: 'Clipboard does not contain an image',
        getImageFromClipboard: (): null => null,
        getImageFromClipboardAsync: async () => ({
          data: 'image-data',
          mediaType: 'image/png' as const,
        }),
      }))
      mock.module('#cli-utils/clipboard', () => ({
        readTextFromClipboard: async (): Promise<null> => null,
      }))

      const { resolveImagePastePlaceholder } =
        await import('#ui-ink/hooks/useTextInputTryImagePaste')

      const messages: Array<{ show: boolean; message?: string }> = []
      let clearCount = 0
      let scheduleCount = 0

      const placeholder = await resolveImagePastePlaceholder({
        mask: '',
        onImagePaste: () => {
          throw new Error('attachment storage unavailable')
        },
        onMessage: (show, message) => {
          messages.push({ show, message })
        },
        clearImagePasteErrorTimeout: () => {
          clearCount += 1
        },
        scheduleImagePasteErrorClear: () => {
          scheduleCount += 1
        },
      })

      expect(placeholder).toBeNull()
      expect(messages).toEqual([
        { show: true, message: 'Reading image from clipboard...' },
        { show: false, message: undefined },
        {
          show: true,
          message: 'Unable to paste the image. Copy it again and retry.',
        },
      ])
      expect(clearCount).toBe(1)
      expect(scheduleCount).toBe(1)
    } finally {
      mock.restore()
    }
  })
})
