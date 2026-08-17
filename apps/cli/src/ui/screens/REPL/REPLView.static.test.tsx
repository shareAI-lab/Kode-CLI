import { afterEach, describe, expect, test } from 'bun:test'
import { Box, Text, render } from 'ink'
import React from 'react'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import PromptInput from '#ui-ink/components/PromptInput'
import type { PromptMode } from '#ui-ink/components/PromptInput/types'
import { KeypressProvider } from '#ui-ink/contexts/KeypressContext'
import {
  killBackgroundAgentTask,
  upsertBackgroundAgentTask,
  type BackgroundAgentTaskRuntime,
} from '#core/utils/backgroundTasks'
import { getMessagesSetter, setMessagesSetter } from '#core/messages'
import { createAssistantMessage } from '#core/utils/messages'
import { setRequestStatus } from '#core/utils/requestStatus'
import { __backgroundTaskSnapshotStoreForTests } from '#ui-ink/hooks/useBackgroundTaskSnapshots'
import { REPL } from './REPL'
import { REPLView } from './REPLView'
import type { TranscriptItem } from './useTranscriptItems'
import { createAssistantStreamStore } from './assistantStreamStore'

const assistantStreamStore = createAssistantStreamStore()
const backgroundTaskIds: string[] = []

type TestHarness = {
  unmount: () => void
  rerender: (element: React.ReactElement) => void
  clearOutput: () => void
  getOutput: () => string
  resize: (columns: number, rows: number) => void
  wait: (ms: number) => Promise<void>
}

const mounted: TestHarness[] = []

afterEach(async () => {
  while (mounted.length > 0) {
    mounted.pop()?.unmount()
  }
  for (const taskId of backgroundTaskIds.splice(0)) {
    killBackgroundAgentTask(taskId)
  }
  __backgroundTaskSnapshotStoreForTests.refreshSnapshot()
  setMessagesSetter(() => {})
  setRequestStatus({ kind: 'idle' })
})

function makeStaticItem(key: string, label = key): TranscriptItem {
  return {
    key,
    jsx: (
      <Box key={key}>
        <Text>{label}</Text>
      </Box>
    ),
  }
}

function addRunningBackgroundTask(): void {
  const taskId = `layout-task-${Date.now()}-${Math.random()}`
  const task: BackgroundAgentTaskRuntime = {
    type: 'async_agent',
    agentId: taskId,
    description: 'Layout stability check',
    prompt: 'Keep this task running for the UI test.',
    status: 'running',
    cwd: process.cwd(),
    startedAt: Date.now(),
    messages: [],
    abortController: new AbortController(),
    done: Promise.resolve(),
  }

  upsertBackgroundAgentTask(task)
  backgroundTaskIds.push(taskId)
  __backgroundTaskSnapshotStoreForTests.refreshSnapshot()
}

function renderReplView(args: {
  staticOutputEpoch: number
  staticItems: TranscriptItem[]
  startupHeader?: React.ReactNode
  startupHeaderKey?: string
  showStartupHeader?: boolean
  transientItems?: TranscriptItem[]
  toolJSX?: {
    jsx: React.ReactNode | null
    shouldHidePromptInput: boolean
    displayMode?: 'inline' | 'fullscreen'
  } | null
  isLoading?: boolean
  shouldShowPromptInput?: boolean
  promptInputProps?: React.ComponentProps<typeof PromptInput>
}) {
  return (
    <REPLView
      conversationKey="test-log:0"
      safeMode={false}
      debug={false}
      staticOutputEpoch={args.staticOutputEpoch}
      staticItems={args.staticItems}
      startupHeader={args.startupHeader}
      startupHeaderKey={args.startupHeaderKey}
      showStartupHeader={args.showStartupHeader}
      transientItems={args.transientItems ?? []}
      assistantStreamStore={assistantStreamStore}
      activeGoal={null}
      toolJSX={args.toolJSX ?? null}
      toolUseConfirm={null}
      setToolUseConfirm={() => {}}
      pendingToolUseConfirmCount={0}
      allowAllPendingToolUseConfirms={() => {}}
      rejectAllPendingToolUseConfirms={() => {}}
      toast={null}
      binaryFeedbackContext={null}
      setBinaryFeedbackContext={() => {}}
      isLoading={args.isLoading ?? false}
      verbose={false}
      normalizedMessages={[]}
      tools={[]}
      erroredToolUseIDs={new Set()}
      inProgressToolUseIDs={new Set()}
      unresolvedToolUseIDs={new Set()}
      showingCostDialog={false}
      onCostDialogDone={() => {}}
      shouldShowPromptInput={args.shouldShowPromptInput ?? false}
      isMessageSelectorVisible={false}
      promptInputProps={args.promptInputProps ?? makePromptInputProps()}
      messageSelectorMessages={[]}
      onMessageSelectorSelect={() => {}}
      onMessageSelectorEscape={() => {}}
    />
  )
}

function makePromptInputProps(
  overrides: Partial<React.ComponentProps<typeof PromptInput>> = {},
): React.ComponentProps<typeof PromptInput> {
  return {
    commands: [],
    forkNumber: 0,
    messageLogName: 'tui',
    isDisabled: false,
    isLoading: false,
    onQuery: async () => {},
    debug: false,
    verbose: false,
    messages: [],
    setToolJSX: () => {},
    tools: [],
    input: '',
    onInputChange: () => {},
    mode: 'prompt' as PromptMode,
    onModeChange: () => {},
    submitCount: 0,
    onSubmitCountChange: () => {},
    setIsLoading: () => {},
    setAbortController: () => {},
    onShowMessageSelector: () => {},
    setForkConvoWithMessagesOnTheNextRender: () => {},
    readFileTimestamps: {},
    abortController: null,
    ...overrides,
  }
}

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
  stdout.columns = options.columns ?? 100
  stdout.rows = options.rows ?? 30

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
    clearOutput: () => {
      rawOutput = ''
    },
    getOutput: () => stripAnsi(rawOutput),
    resize: (columns, rows) => {
      stdout.columns = columns
      stdout.rows = rows
      stdout.emit('resize')
    },
    wait: async ms => new Promise(resolve => setTimeout(resolve, ms)),
  }
  mounted.push(harness)
  return harness
}

function countOccurrences(text: string, needle: string): number {
  if (needle.length === 0) return 0
  return text.split(needle).length - 1
}

describe('REPLView Static output epoch', () => {
  test('keeps Static mounted during ordinary rerenders and resets it only when epoch changes', async () => {
    const staticItems = [makeStaticItem('static-a')]
    const harness = createHarness(
      renderReplView({ staticOutputEpoch: 0, staticItems }),
    )

    await harness.wait(20)
    expect(harness.getOutput()).toContain('static-a')

    harness.clearOutput()
    harness.rerender(renderReplView({ staticOutputEpoch: 0, staticItems }))
    await harness.wait(20)
    expect(harness.getOutput()).not.toContain('static-a')

    harness.clearOutput()
    harness.rerender(renderReplView({ staticOutputEpoch: 1, staticItems }))
    await harness.wait(20)
    expect(harness.getOutput()).toContain('static-a')
  })

  test('does not reprint completed output above the viewport after a fullscreen tool closes', async () => {
    const olderItems = [makeStaticItem('older-output')]
    const completedItems = [...olderItems, makeStaticItem('completed-output')]
    const harness = createHarness(
      renderReplView({ staticOutputEpoch: 0, staticItems: olderItems }),
    )

    await harness.wait(40)
    harness.clearOutput()
    harness.rerender(
      renderReplView({
        staticOutputEpoch: 0,
        staticItems: completedItems,
        toolJSX: {
          jsx: <Text>fullscreen-tool</Text>,
          shouldHidePromptInput: true,
          displayMode: 'fullscreen',
        },
      }),
    )
    await harness.wait(40)
    expect(harness.getOutput()).not.toContain('completed-output')

    harness.clearOutput()
    harness.rerender(
      renderReplView({
        staticOutputEpoch: 0,
        staticItems: completedItems,
      }),
    )
    await harness.wait(40)

    const output = harness.getOutput()
    expect(output).toContain('completed-output')
    expect(output).not.toContain('older-output')
  })

  test('reserves the transient viewport while a request is active', async () => {
    const staticItems = [makeStaticItem('static-a')]
    const harness = createHarness(
      renderReplView({ staticOutputEpoch: 0, staticItems, isLoading: true }),
    )

    await harness.wait(480)

    expect(harness.getOutput()).toContain('static-a')
    expect(harness.getOutput()).toMatch(/(?:\n\s*){4,}/)
  })

  test('renders transient items immediately on initial layout', async () => {
    const harness = createHarness(
      renderReplView({
        staticOutputEpoch: 0,
        staticItems: [],
        transientItems: [makeStaticItem('transient-a')],
      }),
    )

    await harness.wait(40)

    expect(harness.getOutput()).toContain('transient-a')
  })

  test('keeps the transient viewport mounted while an active request is remeasured', async () => {
    const harness = createHarness(
      renderReplView({
        staticOutputEpoch: 0,
        staticItems: [],
        transientItems: [makeStaticItem('transient-a')],
        isLoading: true,
      }),
      { columns: 100, rows: 30 },
    )

    await harness.wait(480)
    expect(harness.getOutput()).toContain('transient-a')

    harness.clearOutput()
    harness.resize(80, 24)
    harness.rerender(
      renderReplView({
        staticOutputEpoch: 0,
        staticItems: [],
        transientItems: [makeStaticItem('transient-b')],
        isLoading: true,
      }),
    )
    await harness.wait(80)

    expect(harness.getOutput()).toContain('transient-b')
  })

  test('pauses transient output during resize measurement and restores it after', async () => {
    const harness = createHarness(
      renderReplView({
        staticOutputEpoch: 0,
        staticItems: [],
        transientItems: [makeStaticItem('transient-a')],
      }),
      { columns: 100, rows: 30 },
    )

    await harness.wait(480)
    expect(harness.getOutput()).toContain('transient-a')

    harness.clearOutput()
    harness.resize(80, 24)
    harness.rerender(
      renderReplView({
        staticOutputEpoch: 0,
        staticItems: [],
        transientItems: [makeStaticItem('transient-b')],
      }),
    )
    await harness.wait(80)
    expect(harness.getOutput()).not.toContain('transient-b')

    await harness.wait(450)
    expect(harness.getOutput()).toContain('transient-b')
  })

  test('keeps the transient viewport mounted while an active request is remeasured', async () => {
    const harness = createHarness(
      renderReplView({
        staticOutputEpoch: 0,
        staticItems: [],
        transientItems: [makeStaticItem('transient-a')],
        isLoading: true,
      }),
      { columns: 100, rows: 30 },
    )

    await harness.wait(480)
    expect(harness.getOutput()).toContain('transient-a')

    harness.clearOutput()
    harness.resize(80, 24)
    harness.rerender(
      renderReplView({
        staticOutputEpoch: 0,
        staticItems: [],
        transientItems: [makeStaticItem('transient-b')],
        isLoading: true,
      }),
    )
    await harness.wait(80)

    expect(harness.getOutput()).toContain('transient-b')
  })

  test('keeps request status visible while resize measurement is settling', async () => {
    setRequestStatus({ kind: 'streaming' })

    const harness = createHarness(
      renderReplView({
        staticOutputEpoch: 0,
        staticItems: [],
        transientItems: [makeStaticItem('transient-a')],
        isLoading: true,
      }),
      { columns: 100, rows: 30 },
    )

    await harness.wait(480)
    expect(harness.getOutput()).toContain('Writing response')

    harness.clearOutput()
    harness.resize(80, 24)
    harness.rerender(
      renderReplView({
        staticOutputEpoch: 0,
        staticItems: [],
        transientItems: [makeStaticItem('transient-b')],
        isLoading: true,
      }),
    )
    await harness.wait(80)
    expect(harness.getOutput()).toContain('Writing response')

    await harness.wait(450)
    expect(harness.getOutput()).toContain('Writing response')
  })

  test('keeps running tasks mounted while resize measurement is settling', async () => {
    addRunningBackgroundTask()

    const harness = createHarness(
      renderReplView({ staticOutputEpoch: 0, staticItems: [] }),
      { columns: 100, rows: 30 },
    )

    await harness.wait(480)
    expect(harness.getOutput()).toContain('Local agents & shells')

    harness.clearOutput()
    harness.resize(80, 24)
    await harness.wait(80)

    expect(harness.getOutput()).toContain('Local agents & shells')
  })

  test('keeps transient output visible when prompt text changes within the same height', async () => {
    const renderWithPrompt = (input: string, transientLabel: string) => (
      <KeypressProvider>
        {renderReplView({
          staticOutputEpoch: 0,
          staticItems: [],
          transientItems: [makeStaticItem(transientLabel)],
          shouldShowPromptInput: true,
          promptInputProps: makePromptInputProps({ input }),
        })}
      </KeypressProvider>
    )

    const harness = createHarness(renderWithPrompt('', 'transient-a'), {
      columns: 100,
      rows: 30,
    })

    await harness.wait(480)
    expect(harness.getOutput()).toContain('transient-a')

    harness.clearOutput()
    harness.rerender(renderWithPrompt('abc', 'transient-b'))
    await harness.wait(80)

    expect(harness.getOutput()).toContain('transient-b')
  })

  test('keeps prompt chrome visible while a control measurement settles', async () => {
    const renderWithPrompt = (input: string) => (
      <KeypressProvider>
        {renderReplView({
          staticOutputEpoch: 0,
          staticItems: [],
          shouldShowPromptInput: true,
          promptInputProps: makePromptInputProps({ input }),
        })}
      </KeypressProvider>
    )
    const harness = createHarness(renderWithPrompt(''), {
      columns: 100,
      rows: 30,
    })

    await harness.wait(480)
    harness.clearOutput()
    harness.rerender(renderWithPrompt('x'.repeat(240)))
    await harness.wait(80)

    expect(harness.getOutput()).toContain('Chat')
  })

  test('updates startup header without reprinting static history', async () => {
    const staticItems = [makeStaticItem('static-a')]
    const harness = createHarness(
      renderReplView({
        staticOutputEpoch: 0,
        staticItems,
        startupHeader: <Text>Header A</Text>,
        startupHeaderKey: 'header-a',
        showStartupHeader: true,
      }),
    )

    await harness.wait(20)
    expect(harness.getOutput()).toContain('static-a')
    expect(harness.getOutput()).toContain('Header A')

    harness.clearOutput()
    harness.rerender(
      renderReplView({
        staticOutputEpoch: 0,
        staticItems,
        startupHeader: <Text>Header B</Text>,
        startupHeaderKey: 'header-b',
        showStartupHeader: true,
      }),
    )
    await harness.wait(20)

    const output = harness.getOutput()
    expect(output).not.toContain('static-a')
    expect(output).toContain('Header B')
  })

  test('remeasures when the live startup header identity changes', async () => {
    const headerA = <Text>Header A</Text>
    const headerB = (
      <Box flexDirection="column">
        <Text>Header B</Text>
        <Text>Header B detail</Text>
      </Box>
    )
    const harness = createHarness(
      renderReplView({
        staticOutputEpoch: 0,
        staticItems: [],
        startupHeader: headerA,
        startupHeaderKey: 'header-a',
        showStartupHeader: true,
        transientItems: [makeStaticItem('transient-a')],
      }),
      { columns: 100, rows: 30 },
    )

    await harness.wait(480)
    expect(harness.getOutput()).toContain('transient-a')

    harness.clearOutput()
    harness.rerender(
      renderReplView({
        staticOutputEpoch: 0,
        staticItems: [],
        startupHeader: headerB,
        startupHeaderKey: 'header-b',
        showStartupHeader: true,
        transientItems: [makeStaticItem('transient-b')],
      }),
    )
    await harness.wait(80)
    expect(harness.getOutput()).not.toContain('transient-b')

    await harness.wait(450)
    expect(harness.getOutput()).toContain('transient-b')
  })

  test('keeps the same live startup header bounded during ordinary rerenders', async () => {
    const harness = createHarness(
      renderReplView({
        staticOutputEpoch: 0,
        staticItems: [],
        startupHeader: <Text>KODE CLI</Text>,
        startupHeaderKey: 'startup-kode',
        showStartupHeader: true,
      }),
    )

    await harness.wait(20)
    expect(harness.getOutput()).toContain('KODE CLI')

    harness.clearOutput()
    harness.rerender(
      renderReplView({
        staticOutputEpoch: 0,
        staticItems: [],
        startupHeader: <Text>KODE CLI</Text>,
        startupHeaderKey: 'startup-kode',
        showStartupHeader: true,
      }),
    )
    await harness.wait(20)

    const output = harness.getOutput()
    expect(countOccurrences(output, 'KODE CLI')).toBeLessThanOrEqual(1)
  })

  test('does not append a stale startup header when its identity changes in the same epoch', async () => {
    const harness = createHarness(
      renderReplView({
        staticOutputEpoch: 0,
        staticItems: [],
        startupHeader: <Text>Header A</Text>,
        startupHeaderKey: 'header-a',
        showStartupHeader: true,
      }),
    )

    await harness.wait(20)
    expect(harness.getOutput()).toContain('Header A')

    harness.clearOutput()
    harness.rerender(
      renderReplView({
        staticOutputEpoch: 0,
        staticItems: [],
        startupHeader: <Text>Header B</Text>,
        startupHeaderKey: 'header-b',
        showStartupHeader: true,
      }),
    )
    await harness.wait(20)

    const output = harness.getOutput()
    expect(output).not.toContain('Header A')
    expect(countOccurrences(output, 'Header B')).toBeLessThanOrEqual(1)
  })

  test('keeps the live startup header bounded when the terminal resizes', async () => {
    const harness = createHarness(
      renderReplView({
        staticOutputEpoch: 0,
        staticItems: [],
        startupHeader: <Text>KODE CLI</Text>,
        startupHeaderKey: 'startup-kode',
        showStartupHeader: true,
      }),
    )

    await harness.wait(20)
    expect(harness.getOutput()).toContain('KODE CLI')

    harness.clearOutput()
    harness.resize(88, 26)
    await harness.wait(220)

    const output = harness.getOutput()
    expect(output).toContain('KODE CLI')
    expect(countOccurrences(output, 'KODE CLI')).toBeLessThanOrEqual(1)
  })

  test('does not reprint static history when the terminal resizes', async () => {
    const staticItems = [makeStaticItem('static-a')]
    const harness = createHarness(
      renderReplView({
        staticOutputEpoch: 0,
        staticItems,
      }),
    )

    await harness.wait(20)
    expect(harness.getOutput()).toContain('static-a')

    harness.clearOutput()
    harness.resize(88, 26)
    await harness.wait(220)

    expect(harness.getOutput()).not.toContain('static-a')
  })

  test('does not reprint static history after shrinking to micro viewport and restoring', async () => {
    const staticItems = [makeStaticItem('static-a')]
    const harness = createHarness(
      renderReplView({
        staticOutputEpoch: 0,
        staticItems,
      }),
      { columns: 100, rows: 24 },
    )

    await harness.wait(80)
    expect(harness.getOutput()).toContain('static-a')

    harness.clearOutput()
    harness.resize(100, 4)
    await harness.wait(80)
    expect(harness.getOutput()).not.toContain('static-a')

    harness.clearOutput()
    harness.resize(100, 24)
    await harness.wait(220)
    expect(harness.getOutput()).not.toContain('static-a')
  })

  test('does not reprint static history after transient zero-size resize and restore', async () => {
    const staticItems = [makeStaticItem('static-a')]
    const harness = createHarness(
      renderReplView({
        staticOutputEpoch: 0,
        staticItems,
      }),
      { columns: 100, rows: 24 },
    )

    await harness.wait(80)
    expect(harness.getOutput()).toContain('static-a')

    harness.clearOutput()
    harness.resize(0, 0)
    await harness.wait(120)
    expect(harness.getOutput()).not.toContain('static-a')

    harness.clearOutput()
    harness.resize(90, 24)
    await harness.wait(520)
    expect(harness.getOutput()).not.toContain('static-a')
  })

  test('does not duplicate prompt controls after normal to micro to normal resize', async () => {
    const renderWithPrompt = () => (
      <KeypressProvider>
        {renderReplView({
          staticOutputEpoch: 0,
          staticItems: [],
          shouldShowPromptInput: true,
          promptInputProps: makePromptInputProps({ input: 'hello' }),
        })}
      </KeypressProvider>
    )

    const harness = createHarness(renderWithPrompt(), {
      columns: 100,
      rows: 24,
    })

    await harness.wait(120)
    expect(
      countOccurrences(harness.getOutput(), 'Chat · Tools'),
    ).toBeLessThanOrEqual(1)

    harness.clearOutput()
    harness.resize(100, 4)
    await harness.wait(120)

    harness.clearOutput()
    harness.resize(100, 24)
    await harness.wait(520)

    const output = harness.getOutput()
    expect(output).toContain('Chat · Tools')
    expect(countOccurrences(output, 'Chat · Tools')).toBeLessThanOrEqual(1)
  })

  test('does not print static history when first rendered in a micro viewport', async () => {
    const staticItems = [makeStaticItem('static-a')]
    const harness = createHarness(
      renderReplView({
        staticOutputEpoch: 0,
        staticItems,
      }),
      { columns: 100, rows: 4 },
    )

    await harness.wait(80)

    expect(harness.getOutput()).not.toContain('static-a')
  })

  test('does not carry a startup header across static output epoch resets', async () => {
    const harness = createHarness(
      renderReplView({
        staticOutputEpoch: 0,
        staticItems: [],
        startupHeader: <Text>KODE CLI</Text>,
        startupHeaderKey: 'startup-kode',
        showStartupHeader: true,
      }),
    )

    await harness.wait(20)
    expect(harness.getOutput()).toContain('KODE CLI')

    harness.clearOutput()
    harness.rerender(
      renderReplView({
        staticOutputEpoch: 1,
        staticItems: [makeStaticItem('static-a')],
        startupHeader: <Text>KODE CLI</Text>,
        startupHeaderKey: 'startup-kode',
        showStartupHeader: false,
      }),
    )
    await harness.wait(20)

    const output = harness.getOutput()
    expect(output).toContain('static-a')
    expect(output).not.toContain('KODE CLI')
  })

  test('does not insert a large blank gap between startup header and prompt controls', async () => {
    const harness = createHarness(
      <KeypressProvider>
        {renderReplView({
          staticOutputEpoch: 0,
          staticItems: [],
          startupHeader: <Text>Welcome</Text>,
          startupHeaderKey: 'welcome',
          showStartupHeader: true,
          shouldShowPromptInput: true,
          promptInputProps: makePromptInputProps(),
        })}
      </KeypressProvider>,
    )

    await harness.wait(80)

    const output = harness.getOutput()
    expect(output).toContain('Welcome')
    expect(output).toContain('Chat · Tools')
    expect(output).not.toMatch(
      /Welcome[\s\S]*?(?:\n\s*){6,}[\s\S]*?Chat · Tools/,
    )
  })

  test('uses a micro layout in tiny viewports without printing transcript regions', async () => {
    const harness = createHarness(
      renderReplView({
        staticOutputEpoch: 0,
        staticItems: [makeStaticItem('static-a')],
        startupHeader: <Text>KODE CLI</Text>,
        startupHeaderKey: 'startup-kode',
        showStartupHeader: true,
        transientItems: [makeStaticItem('transient-a')],
      }),
      { columns: 80, rows: 4 },
    )

    await harness.wait(80)
    const output = harness.getOutput()

    expect(output).not.toContain('static-a')
    expect(output).not.toContain('KODE CLI')
    expect(output).not.toContain('transient-a')
  })

  test('REPL startup header uses the current terminal height for MCP summary after resize', async () => {
    const messageLogName = `startup-resize-${Date.now()}-${Math.random()}`
    const harness = createHarness(
      <KeypressProvider>
        <REPL
          commands={[]}
          initialPrompt={undefined}
          messageLogName={messageLogName}
          shouldShowPromptInput
          tools={[]}
          verbose={false}
          mcpClients={[{ type: 'connected', name: 'codegraph' } as any]}
          isDefaultModel={false}
        />
      </KeypressProvider>,
      { columns: 100, rows: 24 },
    )

    await harness.wait(120)
    expect(harness.getOutput()).toContain('codegraph')

    harness.clearOutput()
    harness.resize(100, 8)
    await harness.wait(520)

    const output = harness.getOutput()
    expect(output).toContain('MCP Servers:')
    expect(output).toContain('codegraph')
  })

  test('keeps the terminal scrollback anchor during a context-only transcript rewrite', async () => {
    const original = createAssistantMessage('before context compaction')
    const compacted = createAssistantMessage('after context compaction')
    const continued = createAssistantMessage('after context continuation')
    const messageLogName = `context-rewrite-${Date.now()}-${Math.random()}`
    const harness = createHarness(
      <KeypressProvider>
        <REPL
          commands={[]}
          initialMessages={[original]}
          initialPrompt={undefined}
          messageLogName={messageLogName}
          shouldShowPromptInput={false}
          tools={[]}
          verbose={false}
        />
      </KeypressProvider>,
    )

    await harness.wait(120)
    expect(harness.getOutput()).toContain('before context compaction')

    harness.clearOutput()
    getMessagesSetter()([compacted], { preserveTranscript: true })
    await harness.wait(80)

    const output = harness.getOutput()
    expect(output).not.toContain('before context compaction')
    expect(output).not.toContain('after context compaction')

    harness.clearOutput()
    getMessagesSetter()(previous => [...previous, continued])
    await harness.wait(80)

    expect(harness.getOutput()).toContain('after context continuation')
  })

  test('still resets static output for an explicit transcript replacement', async () => {
    const original = createAssistantMessage('before explicit reset')
    const replacement = {
      ...original,
      message: {
        ...original.message,
        content: [
          {
            type: 'text' as const,
            text: 'after explicit reset',
            citations: [] as never[],
          },
        ],
      },
    }
    const messageLogName = `explicit-reset-${Date.now()}-${Math.random()}`
    const harness = createHarness(
      <KeypressProvider>
        <REPL
          commands={[]}
          initialMessages={[original]}
          initialPrompt={undefined}
          messageLogName={messageLogName}
          shouldShowPromptInput={false}
          tools={[]}
          verbose={false}
        />
      </KeypressProvider>,
    )

    await harness.wait(120)
    expect(harness.getOutput()).toContain('before explicit reset')

    harness.clearOutput()
    getMessagesSetter()([replacement])
    await harness.wait(80)

    expect(harness.getOutput()).toContain('after explicit reset')
  })
})
