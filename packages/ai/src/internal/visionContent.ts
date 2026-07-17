import {
  imageBase64ToDataUrl,
  normalizeSupportedImageMediaType,
} from './imageMedia'

export type ExtractedVisionContent = {
  text: string
  imageUrls: string[]
}

export function extractTextAndImageUrls(
  content: unknown,
): ExtractedVisionContent {
  if (typeof content === 'string') {
    return { text: content, imageUrls: [] }
  }

  if (!Array.isArray(content)) {
    if (content === null || content === undefined) {
      return { text: '', imageUrls: [] }
    }
    return { text: JSON.stringify(content), imageUrls: [] }
  }

  const textParts: string[] = []
  const imageUrls: string[] = []

  for (const part of content) {
    if (!part || typeof part !== 'object') {
      continue
    }

    const text = getTextFromPart(part)
    if (text) {
      textParts.push(text)
      continue
    }

    const imageUrl = getImageUrlFromPart(part)
    if (imageUrl) {
      imageUrls.push(imageUrl)
    }
  }

  return {
    text: textParts.join('\n\n'),
    imageUrls,
  }
}

export function getTextFromPart(part: Record<string, any>): string | null {
  const type = part.type
  if (type !== 'text' && type !== 'input_text' && type !== 'output_text') {
    return null
  }

  const text = part.text ?? part.content
  return typeof text === 'string' && text ? text : null
}

export function getImageUrlFromPart(part: Record<string, any>): string | null {
  if (part.type === 'image_url') {
    const image = part.image_url
    const url =
      image && typeof image === 'object' ? image.url : (image ?? part.url)
    return typeof url === 'string' && url ? url : null
  }

  if (part.type === 'input_image') {
    const image = part.image_url
    const url =
      image && typeof image === 'object' ? image.url : (image ?? part.url)
    return typeof url === 'string' && url ? url : null
  }

  if (part.type !== 'image') {
    return null
  }

  const source = part.source
  if (!source || typeof source !== 'object') {
    return null
  }

  if (source.type === 'url' && typeof source.url === 'string') {
    return source.url
  }

  if (source.type === 'base64' && typeof source.data === 'string') {
    const mediaType =
      normalizeSupportedImageMediaType(source.media_type) ?? 'image/png'
    return imageBase64ToDataUrl(source.data, mediaType)
  }

  return null
}

export function toOpenAIImageUrlParts(
  imageUrls: string[],
): Array<{ type: 'image_url'; image_url: { url: string } }> {
  return imageUrls.map(url => ({
    type: 'image_url',
    image_url: { url },
  }))
}

export function toResponsesImageParts(
  imageUrls: string[],
): Array<{ type: 'input_image'; image_url: string }> {
  return imageUrls.map(url => ({
    type: 'input_image',
    image_url: url,
  }))
}
