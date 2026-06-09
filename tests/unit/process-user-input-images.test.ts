import { describe, expect, test } from 'bun:test'
import { processUserInput } from '@utils/messages'

const mockContext = {
  abortController: new AbortController(),
  messageId: 'test',
  readFileTimestamps: {},
  options: {
    commands: [],
    tools: [],
    verbose: false,
    safeMode: false,
    forkNumber: 0,
    messageLogName: 'test',
    maxThinkingTokens: 0,
  },
  setForkConvoWithMessagesOnTheNextRender: () => {},
} as any

describe('processUserInput image attachments', () => {
  test('keeps pasted JPEG media type in user image blocks', async () => {
    const messages = await processUserInput(
      'please inspect [Image #1]',
      'prompt',
      () => {},
      mockContext,
      [
        {
          placeholder: '[Image #1]',
          data: 'anBlZw==',
          mediaType: 'image/jpeg',
        },
      ],
    )

    const content = messages[0]?.message.content as any[]
    expect(Array.isArray(content)).toBe(true)
    const imageBlock = content.find(block => block.type === 'image')
    expect(imageBlock?.source).toMatchObject({
      type: 'base64',
      media_type: 'image/jpeg',
      data: 'anBlZw==',
    })
  })
})
