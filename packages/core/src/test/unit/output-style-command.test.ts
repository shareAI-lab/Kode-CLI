import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import outputStyle from '#cli-commands/builtin/output-style'
import { processUserInput } from '#ui-ink/utils/processUserInput'
import { getCwd, setCwd } from '#core/utils/state'
import { resetCwdProviderForTesting, setCwdProvider } from '#config/cwd'
import { clearOutputStyleCache } from '#cli-services/outputStyles'
import type { ToolUseContext, SetToolJSXFn } from '#core/tooling/Tool'
import type { Message } from '#core/query'
import type { ReactNode } from 'react'

function makeTestCommandContext(): ToolUseContext & {
  setForkConvoWithMessagesOnTheNextRender: (
    forkConvoWithMessages: Message[],
  ) => void
} {
  return {
    abortController: new AbortController(),
    messageId: 'm',
    readFileTimestamps: {},
    options: {
      commands: [outputStyle],
      tools: [],
      verbose: false,
      safeMode: false,
      forkNumber: 0,
      messageLogName: 'test',
      maxThinkingTokens: 0,
    },
    setForkConvoWithMessagesOnTheNextRender: () => {},
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  return value as Record<string, unknown>
}

function extractAssistantText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (!record || record.type !== 'text') continue
    parts.push(String(record.text ?? ''))
  }
  return parts.join('')
}

describe('/output-style (menu + direct set + help)', () => {
  const stripAnsi = (value: string | undefined): string =>
    (value ?? '').replace(/\x1b\[[0-9;]*m/g, '')

  const runnerCwd = process.cwd()
  const originalConfigDir = process.env.KODE_CONFIG_DIR

  let projectDir: string
  let homeDir: string

  beforeEach(async () => {
    clearOutputStyleCache()
    projectDir = mkdtempSync(join(tmpdir(), 'kode-output-style-proj-'))
    homeDir = mkdtempSync(join(tmpdir(), 'kode-output-style-home-'))
    process.env.KODE_CONFIG_DIR = join(homeDir, '.kode')
    await setCwd(projectDir)
    setCwdProvider(getCwd)
  })

  afterEach(async () => {
    clearOutputStyleCache()
    await setCwd(runnerCwd)
    resetCwdProviderForTesting()
    if (originalConfigDir === undefined) delete process.env.KODE_CONFIG_DIR
    else process.env.KODE_CONFIG_DIR = originalConfigDir
    rmSync(projectDir, { recursive: true, force: true })
    rmSync(homeDir, { recursive: true, force: true })
  })

  test('direct set persists outputStyle to .kode/settings.local.json', async () => {
    let message: string | undefined
    const ctx = makeTestCommandContext()

    if (outputStyle.type !== 'local-jsx') {
      throw new Error('Expected outputStyle to be a local-jsx command')
    }
    const jsx = await outputStyle.call(
      (result?: string) => {
        message = result
      },
      ctx,
      'default',
    )

    expect(jsx).toBeNull()
    expect(stripAnsi(message)).toBe('Set output style to default')

    const settingsPath = join(projectDir, '.kode', 'settings.local.json')
    expect(existsSync(settingsPath)).toBe(true)
    const json = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(json.outputStyle).toBe('default')
  })

  test('invalid style does not overwrite existing outputStyle', async () => {
    let msg1: string | undefined
    if (outputStyle.type !== 'local-jsx') {
      throw new Error('Expected outputStyle to be a local-jsx command')
    }
    await outputStyle.call(
      (r?: string) => (msg1 = r),
      makeTestCommandContext(),
      'default',
    )
    expect(stripAnsi(msg1)).toBe('Set output style to default')

    let msg2: string | undefined
    await outputStyle.call(
      (r?: string) => (msg2 = r),
      makeTestCommandContext(),
      'not-a-style',
    )
    expect(msg2).toBe('Invalid output style: not-a-style')

    const settingsPath = join(projectDir, '.kode', 'settings.local.json')
    const json = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(json.outputStyle).toBe('default')
  })

  test('processUserInput passes args to local-jsx commands', async () => {
    const setToolJSXCalls: Array<Parameters<SetToolJSXFn<ReactNode>>[0]> = []
    const setToolJSX: SetToolJSXFn<ReactNode> = value => {
      setToolJSXCalls.push(value)
    }

    const ctx = makeTestCommandContext()

    const messages = await processUserInput(
      '/output-style default',
      'prompt',
      setToolJSX,
      ctx,
      null,
    )

    expect(messages).toHaveLength(2)
    expect(messages[0]?.type).toBe('user')
    const second = messages[1]
    expect(second?.type).toBe('assistant')
    if (!second || second.type !== 'assistant') {
      throw new Error('Expected assistant message')
    }
    expect(stripAnsi(extractAssistantText(second.message.content))).toBe(
      'Set output style to default',
    )

    const settingsPath = join(projectDir, '.kode', 'settings.local.json')
    const json = JSON.parse(readFileSync(settingsPath, 'utf8'))
    expect(json.outputStyle).toBe('default')

    // No JSX should be mounted for non-interactive /output-style [name].
    expect(
      setToolJSXCalls.filter(call => call && typeof call === 'object'),
    ).toHaveLength(0)
  })

  test('inline help and current style are non-interactive', async () => {
    let help: string | undefined
    if (outputStyle.type !== 'local-jsx') {
      throw new Error('Expected outputStyle to be a local-jsx command')
    }
    const jsxHelp = await outputStyle.call(
      (r?: string) => (help = r),
      makeTestCommandContext(),
      'help',
    )
    expect(jsxHelp).toBeNull()
    expect(help).toContain('Run /output-style')

    let current: string | undefined
    const jsxCurrent = await outputStyle.call(
      (r?: string) => (current = r),
      makeTestCommandContext(),
      '?',
    )
    expect(jsxCurrent).toBeNull()
    expect(current).toContain('Current output style:')
  })
})
