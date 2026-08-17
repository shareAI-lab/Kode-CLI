import { afterEach, describe, expect, it } from 'bun:test'
import { render } from 'ink'
import React from 'react'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'

import { getTheme } from '#core/utils/theme'
import {
  __areSuggestionItemPropsEqualForTests,
  __areHelpTextPropsEqualForTests,
  __getSuggestionWindowForTests,
  PromptInputCompletionPanel,
} from './PromptInputCompletionPanel'

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
    resize: (columns, rows = stdout.rows ?? 30) => {
      stdout.columns = columns
      stdout.rows = rows
      stdout.emit('resize')
    },
    wait: async ms => new Promise(resolve => setTimeout(resolve, ms)),
  }
  mounted.push(harness)
  return harness
}

describe('__getSuggestionWindowForTests', () => {
  it('rerenders selected suggestions when their theme color changes', () => {
    const theme = getTheme()
    const suggestion = {
      type: 'command',
      value: '/help',
      displayValue: '/help',
    }
    const props = {
      suggestion,
      isSelected: true,
      theme,
      maxWidth: 80,
    }

    expect(
      __areSuggestionItemPropsEqualForTests(props, {
        ...props,
        theme: { ...theme, suggestion: '#ff0000' },
      }),
    ).toBe(false)
  })

  it('refreshes completion help when a suggestion changes type', () => {
    const theme = getTheme()
    const props = {
      emptyDirMessage: '',
      selectedSuggestion: {
        type: 'command',
        value: '/help',
        displayValue: '/help',
      },
      maxWidth: 80,
      theme,
    }

    expect(
      __areHelpTextPropsEqualForTests(props, {
        ...props,
        selectedSuggestion: { ...props.selectedSuggestion, type: 'agent' },
      }),
    ).toBe(false)
  })

  it('never exceeds available rows in small terminals', () => {
    const rows = 12
    const reservedRows = 10
    const panelRows = Math.min(10, Math.max(1, rows - reservedRows))

    const window = __getSuggestionWindowForTests({
      rows,
      reservedRows,
      selectedIndex: 0,
      suggestionCount: 5,
    })

    const visibleCount = window.endIndex - window.startIndex
    const totalLines =
      visibleCount +
      (window.showTopEllipsis ? 1 : 0) +
      (window.showBottomEllipsis ? 1 : 0) +
      (window.showHelp ? 1 : 0)

    expect(totalLines).toBeLessThanOrEqual(panelRows)
    expect(visibleCount).toBeGreaterThanOrEqual(1)
  })

  it('keeps the selected index visible when scrolling', () => {
    const rows = 30
    const reservedRows = 10
    const panelRows = Math.min(10, Math.max(1, rows - reservedRows))

    const window = __getSuggestionWindowForTests({
      rows,
      reservedRows,
      selectedIndex: 10,
      suggestionCount: 50,
    })

    expect(window.startIndex).toBeLessThanOrEqual(10)
    expect(window.endIndex).toBeGreaterThan(10)

    const visibleCount = window.endIndex - window.startIndex
    const totalLines =
      visibleCount +
      (window.showTopEllipsis ? 1 : 0) +
      (window.showBottomEllipsis ? 1 : 0) +
      (window.showHelp ? 1 : 0)

    expect(totalLines).toBeLessThanOrEqual(panelRows)
  })

  it('falls back to one visible row when the terminal reports zero rows', () => {
    const window = __getSuggestionWindowForTests({
      rows: 0,
      reservedRows: 10,
      selectedIndex: 3,
      suggestionCount: 8,
    })

    expect(window.endIndex - window.startIndex).toBe(1)
    expect(window.showHelp).toBe(false)
    expect(window.startIndex).toBeLessThanOrEqual(3)
    expect(window.endIndex).toBeGreaterThan(3)
  })

  it('keeps long command help and token warning bounded after resize', async () => {
    const longCommand =
      '/mcp__srv__open_resource_template_with_a_very_long_generated_name'
    const harness = createHarness(
      React.createElement(PromptInputCompletionPanel, {
        theme: getTheme(),
        suggestions: [
          {
            type: 'command',
            value: longCommand,
            displayValue: longCommand,
            description:
              'Open an MCP resource template with a very long description that should be truncated inside the current terminal width.',
          },
        ],
        selectedIndex: 0,
        emptyDirMessage: '',
        tokenUsage: 990_000,
        contextLimit: 1_000_000,
        reservedRows: 4,
        rows: 30,
        columns: 100,
      }),
      { columns: 100, rows: 30 },
    )

    await harness.wait(50)
    harness.clearOutput()
    harness.rerender(
      React.createElement(PromptInputCompletionPanel, {
        theme: getTheme(),
        suggestions: [
          {
            type: 'command',
            value: longCommand,
            displayValue: longCommand,
            description:
              'Open an MCP resource template with a very long description that should be truncated inside the current terminal width.',
          },
        ],
        selectedIndex: 0,
        emptyDirMessage: '',
        tokenUsage: 990_000,
        contextLimit: 1_000_000,
        reservedRows: 4,
        rows: 12,
        columns: 56,
      }),
    )
    await harness.wait(250)

    const output = harness.getOutput()
    const lines = output.split(/\r?\n/)
    const nonEmptyLines = lines.filter(line => line.trim().length > 0)
    const finalFrameLines = nonEmptyLines.slice(-2)

    expect(output).toContain('/mcp__srv__open')
    expect(output).toContain('Context low')
    expect(finalFrameLines.some(line => line.includes('Context low'))).toBe(
      true,
    )
    expect(
      Math.max(...finalFrameLines.map(line => line.length)),
    ).toBeLessThanOrEqual(56)
  })
})
