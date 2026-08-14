import { expect, spyOn, test } from 'bun:test'
import { Box, Text, render } from 'ink'
import React from 'react'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import * as markdown from '#core/utils/markdown'
import {
  AssistantStreamPreview,
  getBoundedAssistantStreamPreviewText,
  getLivePreviewHeightBudget,
} from './AssistantStreamPreview'
import { createAssistantStreamStore } from './assistantStreamStore'

async function renderToText(element: React.ReactElement): Promise<string> {
  const stdout = new PassThrough() as PassThrough & {
    isTTY?: boolean
    columns?: number
    rows?: number
  }
  stdout.isTTY = true
  stdout.columns = 80
  stdout.rows = 24

  let rawOutput = ''
  stdout.on('data', chunk => {
    rawOutput += chunk.toString('utf8')
  })

  const instance = render(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  instance.unmount()
  return stripAnsi(rawOutput).replaceAll('\r', '')
}

test('does not reserve a blank viewport before the first token', async () => {
  const store = createAssistantStreamStore()
  const turn = new AbortController()
  store.beginTurn(turn)
  store.handleUpdate(turn, { type: 'start', agentId: 'main' })

  const output = await renderToText(
    <Box flexDirection="column">
      <Text>above</Text>
      <AssistantStreamPreview
        store={store}
        transientItems={[]}
        maxHeight={8}
        isVisible
        isActive={false}
        debug={false}
      />
      <Text>below</Text>
    </Box>,
  )

  const betweenSentinels = output.slice(
    output.indexOf('above') + 'above'.length,
    output.indexOf('below'),
  )
  expect(betweenSentinels).toBe('\n')
})

test('bounds large live previews to the visible terminal budget', () => {
  const text = `${'a'.repeat(900)}tail`

  const preview = getBoundedAssistantStreamPreviewText({
    text,
    maxWidth: 80,
    maxHeight: 2,
  })

  expect(preview).toStartWith('…')
  expect(preview).toEndWith('tail')
  expect(preview.length).toBe(641)
})

test('does not split a surrogate pair at the preview boundary', () => {
  const text = `${'a'.repeat(100)}😀${'b'.repeat(511)}`

  const preview = getBoundedAssistantStreamPreviewText({
    text,
    maxWidth: 1,
    maxHeight: 1,
  })

  expect(preview).toStartWith('…b')
  expect(preview).not.toContain('\uFFFD')
})

test('keeps the combined thinking and text preview within a one-row viewport', () => {
  expect(
    getLivePreviewHeightBudget({
      hasThinking: true,
      hasText: true,
      maxHeight: 1,
    }),
  ).toEqual({ thinking: 0, text: 1 })
})

test('renders the first text delta in the preview', async () => {
  const store = createAssistantStreamStore()
  const turn = new AbortController()
  store.beginTurn(turn)
  store.handleUpdate(turn, { type: 'text_delta', delta: 'streamed text' })

  const output = await renderToText(
    <AssistantStreamPreview
      store={store}
      transientItems={[]}
      maxHeight={8}
      isVisible
      isActive={false}
      debug={false}
    />,
  )

  expect(output).toContain('streamed text')
})

test('renders provider thinking separately from answer text', async () => {
  const store = createAssistantStreamStore({ frameIntervalMs: 1 })
  const turn = new AbortController()
  store.beginTurn(turn)
  store.handleUpdate(turn, {
    type: 'thinking_delta',
    delta: 'Inspect the active rendering path first.',
  })
  store.handleUpdate(turn, {
    type: 'text_delta',
    delta: 'The rendering path is stable now.',
  })
  await new Promise(resolve => setTimeout(resolve, 10))

  const output = await renderToText(
    <AssistantStreamPreview
      store={store}
      transientItems={[]}
      maxHeight={8}
      isVisible
      isActive={false}
      debug={false}
    />,
  )

  expect(output).toContain('Thinking')
  expect(output).toContain('Inspect the active rendering path first.')
  expect(output).toContain('The rendering path is stable now.')
})

test('does not reparse the accumulated markdown on every live delta', async () => {
  const applyMarkdownSpy = spyOn(markdown, 'applyMarkdown')
  const store = createAssistantStreamStore({ frameIntervalMs: 1 })
  const turn = new AbortController()
  store.beginTurn(turn)

  const stdout = new PassThrough() as PassThrough & {
    isTTY?: boolean
    columns?: number
    rows?: number
  }
  stdout.isTTY = true
  stdout.columns = 80
  stdout.rows = 24

  const instance = render(
    <AssistantStreamPreview
      store={store}
      transientItems={[]}
      maxHeight={8}
      isVisible
      isActive={false}
      debug={false}
    />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
    },
  )

  try {
    await new Promise(resolve => setTimeout(resolve, 0))
    store.handleUpdate(turn, { type: 'thinking_delta', delta: '**plan' })
    await new Promise(resolve => setTimeout(resolve, 10))
    store.handleUpdate(turn, { type: 'text_delta', delta: 'streamed text' })
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(applyMarkdownSpy).not.toHaveBeenCalled()
  } finally {
    instance.unmount()
    applyMarkdownSpy.mockRestore()
  }
})

test('keeps the live stream visible when completed transient items overflow', async () => {
  const store = createAssistantStreamStore({ frameIntervalMs: 1 })
  const turn = new AbortController()
  store.beginTurn(turn)
  store.handleUpdate(turn, { type: 'text_delta', delta: 'LIVE-STREAM-ANSWER' })

  const tallCompletedItems = Array.from({ length: 4 }, (_, i) => ({
    key: `completed-${i}`,
    jsx: (
      <Box key={`completed-${i}`} flexDirection="column">
        {Array.from({ length: 40 }, (_, j) => (
          <Text key={j}>{`completed-${i}-line-${j}`}</Text>
        ))}
      </Box>
    ),
  }))

  const output = await renderToText(
    <AssistantStreamPreview
      store={store}
      transientItems={tallCompletedItems}
      maxHeight={10}
      isVisible
      isActive
      debug={false}
    />,
  )

  expect(output).toContain('LIVE-STREAM-ANSWER')
})
