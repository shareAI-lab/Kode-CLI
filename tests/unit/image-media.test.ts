import { describe, expect, test } from 'bun:test'
import {
  detectImageMediaType,
  imageBase64ToDataUrl,
  imageBufferToDataUrl,
  normalizeSupportedImageMediaType,
} from '@utils/image/media'

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
const GIF_BYTES = Buffer.from('GIF89a', 'ascii')
const WEBP_BYTES = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'ascii'),
])

describe('image media helpers', () => {
  test('detects supported raster image MIME types from magic bytes', () => {
    expect(detectImageMediaType(PNG_BYTES)).toBe('image/png')
    expect(detectImageMediaType(JPEG_BYTES)).toBe('image/jpeg')
    expect(detectImageMediaType(GIF_BYTES)).toBe('image/gif')
    expect(detectImageMediaType(WEBP_BYTES)).toBe('image/webp')
  })

  test('returns null for invalid or unknown bytes', () => {
    expect(detectImageMediaType(Buffer.from('not an image'))).toBeNull()
    expect(detectImageMediaType(Buffer.alloc(0))).toBeNull()
  })

  test('normalizes MIME aliases and rejects unsupported image types', () => {
    expect(normalizeSupportedImageMediaType('image/jpg')).toBe('image/jpeg')
    expect(normalizeSupportedImageMediaType('image/svg+xml')).toBeNull()
    expect(
      normalizeSupportedImageMediaType('application/octet-stream'),
    ).toBeNull()
  })

  test('converts image data to data URLs with detected or explicit media type', () => {
    expect(imageBufferToDataUrl(JPEG_BYTES)).toBe(
      `data:image/jpeg;base64,${JPEG_BYTES.toString('base64')}`,
    )
    expect(imageBase64ToDataUrl('Zm9v', 'image/webp')).toBe(
      'data:image/webp;base64,Zm9v',
    )
  })
})
