import { afterEach, describe, expect, test } from 'bun:test'
import { render } from 'ink'
import React from 'react'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import { getTheme } from '#core/utils/theme'
import { KeypressProvider } from '#ui-ink/contexts/KeypressContext'
import { PromptInputView } from './PromptInputView'

type TestHarness = {
  unmount: () => void
  rerender: (element: React.ReactElement) => void
  getOutput: () => string
  clearOutput: () => void
  resize: (columns: number, rows?: number) => void
  wait: (ms: number) => Promise<void>
}

const mounted: TestHarness[] = []

afterEach(() => {
  while (mounted.length > 0) {
    mounted.pop()?.unmount()
  }
})

function createHarness(
  element: React.ReactElement,
  options: { columns?: number; rows?: number } = {},
): TestHarness {
  const stdin = new PassThrough() as PassThrough & {
    isTTY?: boolean
    isRaw?: boolean
    setRawMode?: (enabled: boolean) => void
    ref?: () => void
    unref?: () => void
  }
  stdin.isTTY = true
  stdin.isRaw = true
  stdin.setRawMode = () => {}
  stdin.ref = () => {}
  stdin.unref = () => {}
  stdin.setEncoding('utf8')
  stdin.resume()

  const stdout = new PassThrough() as PassThrough & {
    isTTY?: boolean
    columns?: number
    rows?: number
  }
  stdout.isTTY = true
  stdout.columns = options.columns ?? 120
  stdout.rows = options.rows ?? 24

  let rawOutput = ''
  stdout.on('data', chunk => {
    rawOutput += chunk.toString('utf8')
  })

  const instance = render(element, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
  })

  const harness: TestHarness = {
    unmount: () => instance.unmount(),
    rerender: next => instance.rerender(next),
    getOutput: () => stripAnsi(rawOutput),
    clearOutput: () => {
      rawOutput = ''
    },
    resize: (columns, rows = stdout.rows ?? 24) => {
      stdout.columns = columns
      stdout.rows = rows
      stdout.emit('resize')
    },
    wait: async ms => new Promise(resolve => setTimeout(resolve, ms)),
  }
  mounted.push(harness)
  return harness
}

function renderPromptInputView(args: {
  customStatusLineActive: boolean
  statusLine: string
  message?: { show: boolean; text?: string }
  tokenUsage?: number
  terminalRows?: number
  terminalColumns?: number
  suppressStatusLine?: boolean
  emptyDirMessage?: string
}) {
  const tokenUsage = args.tokenUsage ?? 0
  const terminalRows = args.terminalRows ?? 24
  const terminalColumns = args.terminalColumns ?? 120

  return (
    <KeypressProvider>
      <PromptInputView
        mode="prompt"
        theme={getTheme()}
        currentPwd="C:/repo"
        modelInfo={{
          provider: 'custom-openai',
          name: 'mimo-v2.5-pro',
          contextLength: 1_048_576,
          currentTokens: tokenUsage,
        }}
        input=""
        cursorOffset={0}
        setCursorOffset={() => {}}
        onSubmit={() => {}}
        onChange={() => {}}
        isEditingExternally={false}
        isDisabled={false}
        isLoading={false}
        pendingPrompts={[]}
        queuedPrompts={[]}
        completionActive={false}
        historyIndex={0}
        suggestions={[]}
        selectedIndex={0}
        emptyDirMessage={args.emptyDirMessage ?? ''}
        handleHistoryUp={() => {}}
        handleHistoryDown={() => {}}
        resetHistory={() => {}}
        placeholder=""
        submitCount={0}
        onExit={() => {
          throw new Error('exit')
        }}
        onExitMessage={() => {}}
        onMessage={() => {}}
        onImagePaste={() => {}}
        onTextPaste={() => {}}
        onSpecialKey={() => false}
        exitMessage={{ show: false }}
        message={args.message ?? { show: false }}
        clearInputPending={false}
        rewindPending={false}
        modelSwitchMessage={{ show: false }}
        toastMessage={{ show: false }}
        statusLine={args.statusLine}
        customStatusLineActive={args.customStatusLineActive}
        statusLinePadding={0}
        suppressStatusLine={args.suppressStatusLine}
        tokenUsage={tokenUsage}
        textInputColumns={80}
        textInputMaxHeight={1}
        completionReservedRows={4}
        terminalRows={terminalRows}
        terminalColumns={terminalColumns}
      />
    </KeypressProvider>
  )
}

describe('PromptInputView status line layout', () => {
  test('renders built-in model info when using the default status line', async () => {
    const harness = createHarness(
      renderPromptInputView({
        customStatusLineActive: false,
        statusLine: 'Chat',
      }),
    )

    await harness.wait(20)
    const output = harness.getOutput()

    expect(output).toContain('mimo-v2.5-pro \u00b7 0/1.0M')
    expect(output).toContain('Chat')
    expect(output).not.toContain('[custom-openai]')
    expect(output).not.toContain('(medium)')
    expect(output).not.toContain('/bash command')
    expect(output).not.toContain('/note note')

    const modelInfoLine = output
      .split('\n')
      .find(line => line.includes('mimo-v2.5-pro \u00b7 0/1.0M'))
    expect(modelInfoLine).toContain('Chat')
  })

  test('does not duplicate model info when a custom status line is active', async () => {
    const harness = createHarness(
      renderPromptInputView({
        customStatusLineActive: true,
        statusLine: '[custom-openai] mimo-v2.5-pro: 0 / 1.0',
      }),
    )

    await harness.wait(20)
    const output = harness.getOutput()

    expect(output).toContain('[custom-openai] mimo-v2.5-pro: 0 / 1.0')
    expect(output).not.toContain('0 / 1.0M')
  })

  test('hides built-in model info while a configured status line is pending', async () => {
    const harness = createHarness(
      renderPromptInputView({
        customStatusLineActive: true,
        statusLine: 'Chat',
      }),
    )

    await harness.wait(20)
    const output = harness.getOutput()

    expect(output).toContain('Chat')
    expect(output).not.toContain('[custom-openai] mimo-v2.5-pro')
    expect(output).not.toContain('0 / 1.0M')
  })

  test('shows an empty-directory hint on the status line after completion closes', async () => {
    const harness = createHarness(
      renderPromptInputView({
        customStatusLineActive: false,
        statusLine: 'Chat',
        emptyDirMessage: 'No files in docs/',
      }),
    )

    await harness.wait(20)
    const output = harness.getOutput()

    expect(output).toContain('No files in docs/')
    expect(output).not.toContain('Chat')
  })

  test('lets priority messages use the full status line', async () => {
    const pasteGuardMessage = 'Paste detected. Press Enter again to send.'
    const harness = createHarness(
      renderPromptInputView({
        customStatusLineActive: false,
        statusLine: 'Chat',
        message: { show: true, text: pasteGuardMessage },
      }),
    )

    await harness.wait(20)
    const output = harness.getOutput()

    expect(output).toContain(pasteGuardMessage)
    expect(output).not.toContain('[custom-openai] mimo-v2.5-pro')
  })

  test('renders tool permission state in the status line only once', async () => {
    const harness = createHarness(
      renderPromptInputView({
        customStatusLineActive: false,
        statusLine: 'Chat \u00b7 Tools Plan (shift+tab)',
      }),
    )

    await harness.wait(20)
    const output = harness.getOutput()

    expect(output).toContain('Tools Plan (shift+tab)')
    expect(output).not.toContain('Tool permissions:')
  })

  test('keeps long default status and model info on one bounded row after resize', async () => {
    const longDefaultStatusLine =
      'Chat \u00b7 / commands \u00b7 & bg \u00b7 Tools Edit (shift+tab)'
    const harness = createHarness(
      renderPromptInputView({
        customStatusLineActive: false,
        statusLine: longDefaultStatusLine,
      }),
      { columns: 120 },
    )

    await harness.wait(20)
    harness.rerender(
      renderPromptInputView({
        customStatusLineActive: false,
        statusLine: longDefaultStatusLine,
        terminalColumns: 90,
      }),
    )
    await harness.wait(180)
    harness.rerender(
      renderPromptInputView({
        customStatusLineActive: false,
        statusLine: longDefaultStatusLine,
        terminalColumns: 120,
      }),
    )
    await harness.wait(180)

    const output = harness.getOutput()
    expect(output).toContain('Chat')
    expect(output).toContain('mimo-v2.5-pro')

    const isolatedModelRows = output
      .replace(/\r/g, '\n')
      .split('\n')
      .filter(line => {
        const trimmed = line.trim()
        return trimmed.startsWith('mimo-v2.5-pro') && !line.includes('Chat')
      })
    expect(isolatedModelRows).toHaveLength(0)
  })

  test('keeps resized model status bounded when token warning is active', async () => {
    const harness = createHarness(
      renderPromptInputView({
        customStatusLineActive: false,
        statusLine: 'Chat',
        tokenUsage: 1_000_000,
      }),
      { columns: 120 },
    )

    await harness.wait(220)
    harness.clearOutput()
    harness.rerender(
      renderPromptInputView({
        customStatusLineActive: false,
        statusLine: 'Chat',
        tokenUsage: 1_000_000,
        terminalColumns: 90,
      }),
    )
    await harness.wait(180)

    const output = harness.getOutput()
    const statusRows = output
      .replace(/\r/g, '\n')
      .split('\n')
      .filter(
        line =>
          line.includes('Chat') ||
          line.includes('mimo-v2.5-pro') ||
          line.includes('Context low'),
      )
    expect(statusRows.length).toBeGreaterThan(0)
    expect(statusRows.some(line => line.includes('1.0MContext low'))).toBe(
      false,
    )

    const finalStatusRows = statusRows.slice(-2)
    expect(finalStatusRows.some(line => line.includes('Chat'))).toBe(true)
    expect(finalStatusRows.some(line => line.includes('Context low'))).toBe(
      true,
    )
    expect(
      finalStatusRows.filter(line => line.trim().startsWith('mimo-v2.5-pro')),
    ).toHaveLength(0)
    expect(
      Math.max(...finalStatusRows.map(line => line.length)),
    ).toBeLessThanOrEqual(90)
  })

  test('can suppress nonessential status chrome while the parent layout is settling', async () => {
    const harness = createHarness(
      renderPromptInputView({
        customStatusLineActive: false,
        statusLine: 'Chat',
        suppressStatusLine: true,
      }),
    )

    await harness.wait(20)
    const output = harness.getOutput()

    expect(output).not.toContain('Chat')
    expect(output).not.toContain('[custom-openai] mimo-v2.5-pro')
    expect(output).not.toContain('Context low')
    expect(output).not.toContain('C:/repo')
    expect(output).not.toContain('─')
  })

  test('keeps priority status messages visible while status chrome is suppressed', async () => {
    const harness = createHarness(
      renderPromptInputView({
        customStatusLineActive: false,
        statusLine: 'Chat',
        message: { show: true, text: 'Press Escape again to clear input' },
        suppressStatusLine: true,
      }),
    )

    await harness.wait(20)
    const output = harness.getOutput()

    expect(output).toContain('Press Escape again to clear input')
    expect(output).not.toContain('[custom-openai] mimo-v2.5-pro')
  })

  test('uses a single input row in micro-height terminals', async () => {
    const harness = createHarness(
      renderPromptInputView({
        customStatusLineActive: false,
        statusLine: 'Chat',
        terminalRows: 4,
        terminalColumns: 80,
      }),
      { columns: 80, rows: 4 },
    )

    await harness.wait(20)
    const output = harness.getOutput()

    expect(output).not.toContain('C:/repo')
    expect(output).not.toContain('Chat')
    expect(output).not.toContain('[custom-openai] mimo-v2.5-pro')
  })
})
