const NO_CONTENT_MESSAGE = '(no content)'

export function normalizeContentFromAPI<
  T extends { type: string; text?: string },
>(content: T[]): T[] {
  const filteredContent = content.filter(
    block => block.type !== 'text' || Boolean(block.text?.trim().length),
  )

  if (filteredContent.length === 0) {
    return [
      {
        type: 'text',
        text: NO_CONTENT_MESSAGE,
        citations: [],
      } as unknown as T,
    ]
  }

  return filteredContent
}
