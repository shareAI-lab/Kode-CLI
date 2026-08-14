import { describe, expect, it } from 'bun:test'
import { Box, Text, render } from 'ink'
import React from 'react'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import { renderWebSearchToolResultMessage } from './WebSearchToolPresenter'
import { renderInkToolResultMessage } from './registry'
import type { Tool } from '#core/tooling/Tool'

async function renderToText(el: React.ReactElement): Promise<string> {
  const stdout = new PassThrough() as any
  stdout.isTTY = true
  let raw = ''
  stdout.on('data', (c: Buffer) => {
    raw += c.toString('utf8')
  })
  const inst = render(el, { stdout, exitOnCtrlC: false })
  await new Promise(r => setTimeout(r, 10))
  inst.unmount()
  return stripAnsi(raw).replaceAll('\r', '')
}

describe('WebSearchToolPresenter', () => {
  it('uses the generic renderer for Fetch output instead of a search summary', async () => {
    const fetchTool = {
      name: 'Fetch',
      renderToolResultMessage: (output: unknown) => String(output),
    } as unknown as Tool
    const text = await renderToText(
      <>
        {renderInkToolResultMessage(fetchTool, 'Fetched page body', {
          verbose: false,
        })}
      </>,
    )

    expect(text).toContain('Fetched page body')
    expect(text).not.toContain('Search')
  })

  it('summarizes hits and providers in one line', async () => {
    const output = {
      query: '今天天气',
      results: [
        { tool_use_id: 'x', content: [{ title: 'a', url: 'https://a' }] },
      ],
      durationSeconds: 0.8,
      providers: ['duckduckgo', 'bing', 'baidu'],
    }
    const text = await renderToText(
      <>{renderWebSearchToolResultMessage(output, { verbose: false })}</>,
    )
    console.log('RESULT:', JSON.stringify(text.trim()))
    expect(text).toContain('✓ Search')
    expect(text).toContain('1 results')
    expect(text).toContain('duckduckgo, bing, baidu')
  })

  it('lists individual hits in verbose mode', async () => {
    const output = {
      query: 'q',
      results: [
        {
          tool_use_id: 'x',
          content: [{ title: 'hit-one', url: 'https://one' }],
        },
      ],
      providers: ['baidu'],
    }
    const text = await renderToText(
      <>{renderWebSearchToolResultMessage(output, { verbose: true })}</>,
    )
    console.log('VERBOSE:', JSON.stringify(text.trim()))
    expect(text).toContain('hit-one')
    expect(text).toContain('https://one')
  })
})
