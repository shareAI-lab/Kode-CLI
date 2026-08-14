import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { Box, render } from 'ink'
import React from 'react'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import { marked } from 'marked'
import type { AssistantMessage } from '#core/query'
import { Message } from './Message'
import { ToolUseLoader } from './ToolUseLoader'
import { AssistantThinkingMessage } from './messages/AssistantThinkingMessage'
import { BashToolRunInBackgroundOverlay } from '#tools/tools/system/BashTool/BashToolRunInBackgroundOverlay'
import { RequestStatusIndicator } from './RequestStatusIndicator'
import { setRequestStatus } from '#core/utils/requestStatus'

type TestHarness = {
  unmount: () => void
  getOutput: () => string
  getRenderCount: () => number
  wait: (ms: number) => Promise<void>
}

const mounted: TestHarness[] = []
const thinkingMessage = {
  type: 'assistant',
  uuid: '00000000-0000-4000-8000-000000000001',
  costUSD: 0,
  durationMs: 0,
  message: {
    id: 'msg_thinking',
    model: 'test',
    role: 'assistant',
    type: 'message',
    content: [
      {
        type: 'thinking',
        thinking: 'Review the animation lifecycle.',
        signature: '',
      },
    ],
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  },
} as unknown as AssistantMessage

afterEach(() => {
  while (mounted.length > 0) {
    mounted.pop()?.unmount()
  }
  setRequestStatus({ kind: 'idle' })
  mock.restore()
})

function createHarness(
  element: React.ReactElement,
  { isScreenReaderEnabled = false } = {},
): TestHarness {
  const stdout = new PassThrough() as PassThrough & {
    isTTY?: boolean
    columns?: number
    rows?: number
  }
  stdout.isTTY = true
  stdout.columns = 80
  stdout.rows = 24

  let rawOutput = ''
  let renderCount = 0
  stdout.on('data', chunk => {
    rawOutput += chunk.toString('utf8')
  })

  const instance = render(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
    isScreenReaderEnabled,
    maxFps: 120,
    onRender: () => {
      renderCount += 1
    },
  })

  const harness: TestHarness = {
    unmount: () => instance.unmount(),
    getOutput: () => stripAnsi(rawOutput),
    getRenderCount: () => renderCount,
    wait: async ms => new Promise(resolve => setTimeout(resolve, ms)),
  }
  mounted.push(harness)
  return harness
}

function renderThinkingMessage(
  shouldAnimate: boolean,
  isTransient = false,
): React.ReactElement {
  return (
    <Message
      message={thinkingMessage}
      messages={[]}
      addMargin={false}
      tools={[]}
      verbose={false}
      debug={false}
      erroredToolUseIDs={new Set()}
      inProgressToolUseIDs={new Set()}
      unresolvedToolUseIDs={new Set()}
      shouldAnimate={shouldAnimate}
      shouldShowDot={false}
      isTransient={isTransient}
    />
  )
}

describe('animation lifecycle', () => {
  test('does not install timers or update inactive historical rows', async () => {
    const setIntervalSpy = spyOn(globalThis, 'setInterval')
    const harness = createHarness(
      <Box flexDirection="column">
        <ToolUseLoader
          isError={false}
          isUnresolved={false}
          shouldAnimate={false}
        />
        {renderThinkingMessage(false)}
      </Box>,
    )

    await harness.wait(40)
    const initialOutput = harness.getOutput()
    const initialRenderCount = harness.getRenderCount()

    expect(setIntervalSpy).not.toHaveBeenCalled()
    await harness.wait(220)
    expect(setIntervalSpy).not.toHaveBeenCalled()
    expect(harness.getRenderCount()).toBe(initialRenderCount)
    expect(harness.getOutput()).toBe(initialOutput)
  })

  test('keeps completed thinking static even while the request status is active', async () => {
    const setIntervalSpy = spyOn(globalThis, 'setInterval')
    const harness = createHarness(renderThinkingMessage(true, false))

    await harness.wait(40)
    const initialOutput = harness.getOutput()
    const initialRenderCount = harness.getRenderCount()

    expect(setIntervalSpy).not.toHaveBeenCalled()
    await harness.wait(220)
    expect(harness.getRenderCount()).toBe(initialRenderCount)
    expect(harness.getOutput()).toBe(initialOutput)
  })

  test('keeps the active tool loader updating', async () => {
    const setIntervalSpy = spyOn(globalThis, 'setInterval')
    const harness = createHarness(
      <ToolUseLoader isError={false} isUnresolved={true} shouldAnimate />,
    )

    await harness.wait(40)
    const initialOutput = harness.getOutput()
    const initialRenderCount = harness.getRenderCount()

    expect(setIntervalSpy).toHaveBeenCalledTimes(1)
    await harness.wait(120)
    expect(harness.getRenderCount()).toBeGreaterThan(initialRenderCount)
    expect(harness.getOutput()).not.toBe(initialOutput)
  })

  test('updates active thinking without reparsing its markdown', async () => {
    const setIntervalSpy = spyOn(globalThis, 'setInterval')
    const markdownSpy = spyOn(marked, 'lexer')
    const longReasoning = `## Plan\n\n${'Check the current state. '.repeat(200)}`
    const harness = createHarness(
      <AssistantThinkingMessage
        param={{
          type: 'thinking',
          thinking: longReasoning,
          signature: '',
        }}
        addMargin={false}
        shouldAnimate
      />,
    )

    await harness.wait(40)
    const initialOutput = harness.getOutput()
    const initialRenderCount = harness.getRenderCount()
    const initialMarkdownCalls = markdownSpy.mock.calls.length

    expect(setIntervalSpy).toHaveBeenCalledTimes(1)
    expect(initialMarkdownCalls).toBe(1)
    await harness.wait(210)
    expect(harness.getRenderCount()).toBeGreaterThan(initialRenderCount)
    expect(harness.getOutput()).not.toBe(initialOutput)
    expect(markdownSpy).toHaveBeenCalledTimes(initialMarkdownCalls)
  })

  test('keeps active indicators static for screen readers', async () => {
    const setIntervalSpy = spyOn(globalThis, 'setInterval')
    const harness = createHarness(
      <Box flexDirection="column">
        <ToolUseLoader isError={false} isUnresolved={true} shouldAnimate />
        <AssistantThinkingMessage
          param={{
            type: 'thinking',
            thinking: 'Accessible reasoning output.',
            signature: '',
          }}
          addMargin={false}
          shouldAnimate
        />
      </Box>,
      { isScreenReaderEnabled: true },
    )

    await harness.wait(40)
    const initialOutput = harness.getOutput()
    const initialRenderCount = harness.getRenderCount()

    expect(initialOutput).toContain('⠋')
    expect(initialOutput).toContain('[Thinking /]')
    expect(setIntervalSpy).not.toHaveBeenCalled()
    await harness.wait(220)
    expect(setIntervalSpy).not.toHaveBeenCalled()
    expect(harness.getRenderCount()).toBe(initialRenderCount)
    expect(harness.getOutput()).toBe(initialOutput)
  })

  test('shows and animates the active Bash tool status', async () => {
    setRequestStatus({ kind: 'tool', detail: 'Bash' })
    const setIntervalSpy = spyOn(globalThis, 'setInterval')
    const harness = createHarness(<BashToolRunInBackgroundOverlay />)

    await harness.wait(40)
    expect(harness.getOutput()).toContain('Working · Bash')
    expect(setIntervalSpy).toHaveBeenCalled()
  })

  test('keeps the Bash request status static for screen readers', async () => {
    setRequestStatus({ kind: 'thinking', inputTokens: 42 })
    const setIntervalSpy = spyOn(globalThis, 'setInterval')
    const harness = createHarness(<BashToolRunInBackgroundOverlay />, {
      isScreenReaderEnabled: true,
    })

    await harness.wait(40)
    const initialOutput = harness.getOutput()
    const initialRenderCount = harness.getRenderCount()

    expect(initialOutput).toContain('Thinking')
    expect(setIntervalSpy).not.toHaveBeenCalled()
    await harness.wait(220)
    expect(harness.getRenderCount()).toBe(initialRenderCount)
    expect(harness.getOutput()).toBe(initialOutput)
  })

  test('keeps the main REPL request status static for screen readers', async () => {
    setRequestStatus({ kind: 'thinking', inputTokens: 42 })
    const setIntervalSpy = spyOn(globalThis, 'setInterval')
    const harness = createHarness(<RequestStatusIndicator />, {
      isScreenReaderEnabled: true,
    })

    await harness.wait(40)
    const initialOutput = harness.getOutput()
    const initialRenderCount = harness.getRenderCount()

    expect(initialOutput).toContain('Thinking')
    expect(setIntervalSpy).not.toHaveBeenCalled()
    await harness.wait(220)
    expect(harness.getRenderCount()).toBe(initialRenderCount)
    expect(harness.getOutput()).toBe(initialOutput)
  })

  test('animates the main REPL request status for sighted users', async () => {
    setRequestStatus({ kind: 'streaming', outputTokens: 12_500 })
    const setIntervalSpy = spyOn(globalThis, 'setInterval')
    const harness = createHarness(<RequestStatusIndicator />)

    await harness.wait(40)
    const output = harness.getOutput()

    expect(output).toContain('Writing response')
    expect(output).toContain('↓ 13k')
    expect(output).toContain('(Esc cancel)')
    expect(setIntervalSpy).toHaveBeenCalled()
  })
})
