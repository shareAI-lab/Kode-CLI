import { describe, expect, test } from 'bun:test'
import type { Command } from '#cli-commands'
import { processUserInput } from '#ui-ink/utils/processUserInput'
import { __getCompletionContextForTests } from '#ui-ink/hooks/useUnifiedCompletion'
import type { ToolUseContext } from '#core/tooling/Tool'
import type { Message } from '#core/query'

describe('--disable-slash-commands (compatibility)', () => {
  test('processUserInput treats /cmd as command only when enabled', async () => {
    const helpCommand = {
      type: 'local',
      name: 'help',
      description: 'help',
      isEnabled: true,
      isHidden: false,
      userFacingName() {
        return 'help'
      },
      async call() {
        return 'OK'
      },
    } satisfies Command

    const baseContext = {
      options: {
        commands: [helpCommand],
        tools: [] as any[],
        verbose: false,
        permissionMode: 'cautious',
        disableSlashCommands: false,
      },
      messageId: undefined as string | undefined,
      abortController: new AbortController(),
      readFileTimestamps: {},
      setForkConvoWithMessagesOnTheNextRender(_fork: Message[]) {},
    } satisfies ToolUseContext & {
      setForkConvoWithMessagesOnTheNextRender: (fork: Message[]) => void
    }

    const enabled = await processUserInput(
      '/help',
      'prompt',
      () => {},
      baseContext,
      null,
    )
    expect(enabled.length).toBe(2)
    expect(enabled[0]?.type).toBe('user')
    {
      const first = enabled[0]
      if (!first || first.type !== 'user')
        throw new Error('Expected user message')
      const text =
        typeof first.message.content === 'string'
          ? first.message.content
          : JSON.stringify(first.message.content)
      expect(text).toContain('<command-name>help</command-name>')
    }
    expect(enabled[1]?.type).toBe('assistant')
    {
      const second = enabled[1]
      if (!second || second.type !== 'assistant') {
        throw new Error('Expected assistant message')
      }
      const content = second.message.content
      const text = Array.isArray(content)
        ? content
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('')
        : String(content ?? '')
      expect(text).toContain('<local-command-stdout>OK</local-command-stdout>')
    }

    const disabled = await processUserInput(
      '/help',
      'prompt',
      () => {},
      {
        ...baseContext,
        options: { ...baseContext.options, disableSlashCommands: true },
      },
      null,
    )
    expect(disabled.length).toBe(1)
    expect(disabled[0]?.type).toBe('user')
    {
      const first = disabled[0]
      if (!first || first.type !== 'user')
        throw new Error('Expected user message')
      const text =
        typeof first.message.content === 'string'
          ? first.message.content
          : JSON.stringify(first.message.content)
      expect(text).toBe('/help')
    }
  })

  test('unified completion does not classify /foo as command when disabled', () => {
    const enabled = __getCompletionContextForTests({
      input: '/he',
      cursorOffset: 3,
      disableSlashCommands: false,
    })
    expect(enabled?.type).toBe('command')
    expect(enabled?.prefix).toBe('he')

    const disabled = __getCompletionContextForTests({
      input: '/he',
      cursorOffset: 3,
      disableSlashCommands: true,
    })
    expect(disabled?.type).toBe('file')
    expect(disabled?.prefix).toBe('/he')
  })
})
