import { describe, expect, test } from 'bun:test'

import { createInteractivePromptMessage } from './slashCommands'

describe('interactive local JSX prompt submission', () => {
  test('turns a reviewed voice result into one normal user message', () => {
    const message = createInteractivePromptMessage({
      type: 'submit-prompt',
      prompt: '  继续检查当前改动  ',
      voiceInput: true,
      voiceResponse: true,
    })
    expect(message).toMatchObject({
      type: 'user',
      message: { role: 'user', content: '继续检查当前改动' },
      options: { voiceInput: true, voiceResponse: true },
    })
  })

  test('does not create an empty or display-only user prompt', () => {
    expect(
      createInteractivePromptMessage({ type: 'submit-prompt', prompt: '   ' }),
    ).toBeNull()
    expect(createInteractivePromptMessage('done')).toBeNull()
  })
})
