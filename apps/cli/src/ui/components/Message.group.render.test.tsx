import { describe, expect, it } from 'bun:test'
import { Box, Text, render } from 'ink'
import React from 'react'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import { Message } from './Message'

function makeAssistantMessage(content: unknown[]) {
  return {
    type: 'assistant',
    uuid: crypto.randomUUID(),
    costUSD: 0,
    durationMs: 0,
    message: {
      id: 'm1',
      model: 'x',
      role: 'assistant',
      type: 'message',
      content,
      usage: {} as never,
    },
  } as any
}

async function renderToText(el: React.ReactElement): Promise<string> {
  const stdout = new PassThrough() as any
  stdout.isTTY = true
  let raw = ''
  stdout.on('data', (c: Buffer) => {
    raw += c.toString('utf8')
  })
  const inst = render(el, {
    stdout,
    exitOnCtrlC: false,
    columns: 100,
    rows: 30,
  })
  await new Promise(r => setTimeout(r, 20))
  inst.unmount()
  return stripAnsi(raw).replaceAll('\r', '')
}

describe('Message group rendering', () => {
  it('renders grouped web searches without crashing', async () => {
    const message = makeAssistantMessage([
      {
        type: 'tool_use',
        id: 'call_1',
        name: 'web_search',
        input: { query: '今天天气 2025' },
      },
      {
        type: 'tool_use',
        id: 'call_2',
        name: 'web_search',
        input: { query: 'current weather today' },
      },
      { type: 'text', text: 'done' },
    ])

    const out = await renderToText(
      <Message
        message={message}
        messages={[]}
        addMargin={false}
        tools={[]}
        verbose={false}
        debug={false}
        erroredToolUseIDs={new Set()}
        inProgressToolUseIDs={new Set()}
        unresolvedToolUseIDs={new Set()}
        shouldAnimate={false}
        shouldShowDot={false}
      />,
    )
    console.log(
      'RENDER:',
      JSON.stringify(out.replace(/\s+/g, ' ').trim().slice(0, 200)),
    )
    expect(out).toContain('Search')
    expect(out).toContain('今天天气 2025')
    expect(out).toContain('current weather today')
    expect(out).toContain('done')
  })

  it('keeps an unavailable tool call visible instead of dropping it', async () => {
    const message = makeAssistantMessage([
      {
        type: 'tool_use',
        id: 'call_missing',
        name: 'UnloadedTool',
        input: { path: '/tmp/example.ts' },
      },
    ])

    const out = await renderToText(
      <Message
        message={message}
        messages={[]}
        addMargin={false}
        tools={[]}
        verbose={false}
        debug={false}
        erroredToolUseIDs={new Set()}
        inProgressToolUseIDs={new Set()}
        unresolvedToolUseIDs={new Set()}
        shouldAnimate={false}
        shouldShowDot={false}
      />,
    )

    expect(out).toContain('UnloadedTool')
    expect(out).toContain('tool unavailable')
  })
})
