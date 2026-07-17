/**
 * Minimal image media helpers for OpenAI message conversion.
 * Host-agnostic subset of core image/media.
 */

export type SupportedImageMediaType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp'

export const SUPPORTED_IMAGE_MEDIA_TYPES: readonly SupportedImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const

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

export function imageBase64ToDataUrl(
  data: string,
  mediaType: SupportedImageMediaType,
): string {
  return `data:${mediaType};base64,${data}`
}
