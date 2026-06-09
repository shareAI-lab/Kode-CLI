export type SupportedImageMediaType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp'

export type ClipboardImage = {
  data: string
  mediaType: SupportedImageMediaType
}

export const SUPPORTED_IMAGE_MEDIA_TYPES: readonly SupportedImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const

export const SVG_MEDIA_TYPE = 'image/svg+xml'

export function normalizeSupportedImageMediaType(
  mediaType: unknown,
): SupportedImageMediaType | null {
  if (typeof mediaType !== 'string') {
    return null
  }

  const normalized = mediaType.trim().toLowerCase()
  if (normalized === 'image/jpg') {
    return 'image/jpeg'
  }

  return SUPPORTED_IMAGE_MEDIA_TYPES.includes(
    normalized as SupportedImageMediaType,
  )
    ? (normalized as SupportedImageMediaType)
    : null
}

export function detectImageMediaType(
  input: Buffer | Uint8Array,
): SupportedImageMediaType | null {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input)

  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png'
  }

  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return 'image/jpeg'
  }

  if (
    buffer.length >= 6 &&
    (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' ||
      buffer.subarray(0, 6).toString('ascii') === 'GIF89a')
  ) {
    return 'image/gif'
  }

  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }

  return null
}

export function getImageMediaTypeFromExtension(
  ext: string,
): SupportedImageMediaType | null {
  switch (ext.toLowerCase()) {
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.gif':
      return 'image/gif'
    case '.webp':
      return 'image/webp'
    default:
      return null
  }
}

export function imageBase64ToDataUrl(
  data: string,
  mediaType: SupportedImageMediaType,
): string {
  return `data:${mediaType};base64,${data}`
}

export function imageBufferToDataUrl(
  buffer: Buffer | Uint8Array,
  mediaType = detectImageMediaType(buffer),
): string | null {
  if (!mediaType) {
    return null
  }

  const data = Buffer.isBuffer(buffer)
    ? buffer.toString('base64')
    : Buffer.from(buffer).toString('base64')
  return imageBase64ToDataUrl(data, mediaType)
}

export function isSvgExtension(ext: string): boolean {
  return ext.toLowerCase() === '.svg'
}

export function isSvgBuffer(input: Buffer | Uint8Array): boolean {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input)
  const prefix = buffer
    .subarray(0, Math.min(buffer.length, 1024))
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart()
    .toLowerCase()

  return (
    prefix.startsWith('<svg') ||
    (prefix.startsWith('<?xml') && prefix.includes('<svg'))
  )
}

export async function rasterizeSvgToPng(
  input: Buffer | Uint8Array,
): Promise<Buffer> {
  const sharpModule = (await import('sharp')) as any
  const sharp = sharpModule.default || sharpModule
  return await sharp(Buffer.isBuffer(input) ? input : Buffer.from(input))
    .png()
    .toBuffer()
}
