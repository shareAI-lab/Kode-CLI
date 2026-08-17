import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { processUserInput } from '#ui-ink/utils/processUserInput'
import { __parseBuiltinInputCommandForTests } from '#ui-ink/utils/builtinInputCommands'
import {
  getCwd,
  getOriginalCwd,
  setCwd,
  setOriginalCwd,
} from '#core/utils/state'
import { __setLlmLazyQueryQuickLoaderForTests } from '#core/ai/llmLazy'
import { createAssistantMessage } from '#core/utils/messages'

function makeContext(overrides?: { disableSlashCommands?: boolean }) {
  return {
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
      disableSlashCommands: overrides?.disableSlashCommands ?? false,
    },
    setForkConvoWithMessagesOnTheNextRender: () => {},
  } as any
}

function extractAssistantText(messages: any[]): string {
  const assistant = messages.find(message => message.type === 'assistant')
  const content = assistant?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((block: any) => block?.type === 'text')
      .map((block: any) => block.text ?? '')
      .join('')
  }
  return ''
}

describe('prompt command input', () => {
  let runnerProcessCwd: string
  let runnerShellCwd: string
  let runnerOriginalCwd: string
  let projectDir: string

  beforeEach(async () => {
    runnerProcessCwd = process.cwd()
    runnerShellCwd = getCwd()
    runnerOriginalCwd = getOriginalCwd()
    projectDir = mkdtempSync(join(tmpdir(), 'kode-prompt-command-test-'))
    mkdirSync(join(projectDir, 'foo'), { recursive: true })
    process.chdir(projectDir)
    await setCwd(projectDir)
    setOriginalCwd(projectDir)
  })

  afterEach(async () => {
    __setLlmLazyQueryQuickLoaderForTests(null)
    process.chdir(runnerProcessCwd)
    await setCwd(runnerShellCwd)
    setOriginalCwd(runnerOriginalCwd)
    rmSync(projectDir, { recursive: true, force: true })
  })

  test('parses built-in input commands', () => {
    expect(__parseBuiltinInputCommandForTests('/bash ls -la')).toEqual({
      name: 'bash',
      args: 'ls -la',
    })
    expect(__parseBuiltinInputCommandForTests('/note Remember')).toEqual({
      name: 'note',
      args: 'Remember',
    })
    expect(__parseBuiltinInputCommandForTests('/help')).toBeNull()
  })

  test('/bash executes through the existing Bash input path', async () => {
    const messages = await processUserInput(
      '/bash cd foo ',
      'prompt',
      () => {},
      makeContext(),
      null,
    )

    expect(messages).toHaveLength(2)
    expect(extractAssistantText(messages)).toContain('Changed directory to')
    expect(getCwd()).toBe(join(projectDir, 'foo'))
  })

  test('unknown slash commands stay local and suggest nearby names', async () => {
    const context = makeContext()
    context.options.commands = [
      {
        type: 'local',
        name: 'help',
        description: 'Show help',
        isEnabled: true,
        isHidden: false,
        userFacingName: () => 'help',
        aliases: ['h'],
        call: async () => '',
      },
    ]

    const messages = await processUserInput(
      '/hepl',
      'prompt',
      () => {},
      context,
      null,
    )

    expect(messages).toHaveLength(1)
    expect(messages[0]?.type).toBe('assistant')
    const text = extractAssistantText(messages)
    expect(text).toContain('Unknown command: /hepl')
    expect(text).toContain('/help')
    expect(text).toContain('//')
    expect(text).not.toContain('EISDIR')
  })

  test('// sends a literal slash line to the model', async () => {
    const messages = await processUserInput(
      '//not-a-command',
      'prompt',
      () => {},
      makeContext(),
      null,
    )

    expect(messages).toHaveLength(1)
    expect(messages[0]?.type).toBe('user')
    const content = (messages[0] as { message?: { content?: unknown } }).message
      ?.content
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((block: { text?: string }) => block.text ?? '').join('')
          : ''
    expect(text).toBe('/not-a-command')
  })

  test('/bash is plain text when slash commands are disabled', async () => {
    const messages = await processUserInput(
      '/bash cd foo',
      'prompt',
      () => {},
      makeContext({ disableSlashCommands: true }),
      null,
    )

    expect(messages).toHaveLength(1)
    expect(messages[0]?.type).toBe('user')
    expect(getCwd()).toBe(projectDir)
  })

  test('/note writes the note to AGENTS.md', async () => {
    __setLlmLazyQueryQuickLoaderForTests(
      async () => async () =>
        createAssistantMessage('# API Docs\n\nRemember to update API docs.'),
    )

    const messages = await processUserInput(
      '/note Remember to update API docs',
      'prompt',
      () => {},
      makeContext(),
      null,
    )

    const agentsPath = join(projectDir, 'AGENTS.md')
    expect(existsSync(agentsPath)).toBe(true)
    expect(readFileSync(agentsPath, 'utf8')).toContain(
      'Remember to update API docs.',
    )
    expect(extractAssistantText(messages)).toContain('Note saved to AGENTS.md.')
  })

  test('/note reports a safe error when AGENTS.md cannot be written', async () => {
    mkdirSync(join(projectDir, 'AGENTS.md'))
    __setLlmLazyQueryQuickLoaderForTests(
      async () => async () => createAssistantMessage('# API Docs'),
    )

    const messages = await processUserInput(
      '/note Remember to update API docs',
      'prompt',
      () => {},
      makeContext(),
      null,
    )

    expect(extractAssistantText(messages)).toContain(
      'Unable to save the note to AGENTS.md. Check the file path and permissions, then retry.',
    )
    expect(extractAssistantText(messages)).not.toContain('EISDIR')
  })
})
