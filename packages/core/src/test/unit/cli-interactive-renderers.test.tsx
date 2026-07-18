import { describe, expect, test } from 'bun:test'
import React from 'react'
import type { RenderOptions } from 'ink'

import { renderRepl } from '#host-cli/entrypoints/cli/interactive/renderers'

describe('cli interactive renderers', () => {
  test('renderRepl wires props into Ink render (injected deps)', async () => {
    function FakeRepl() {
      return null
    }

    let capturedElement: React.ReactElement | null = null
    let capturedOptions: RenderOptions | undefined

    const fakeRender = (
      element: React.ReactElement,
      options?: RenderOptions,
    ) => {
      capturedElement = element
      capturedOptions = options
      return { unmount: () => {} }
    }

    await renderRepl(
      {
        initialPrompt: 'hello',
        messageLogName: 'log',
        shouldShowPromptInput: true,
      },
      { exitOnCtrlC: false },
      { render: fakeRender, REPL: FakeRepl },
    )

    expect(capturedElement).not.toBeNull()
    if (!capturedElement) throw new Error('expected element to be rendered')
    const replElement = React.Children.only(
      (capturedElement.props as { children: React.ReactNode }).children,
    ) as React.ReactElement
    expect(replElement.type).toBe(FakeRepl)
    const props = replElement.props as {
      initialPrompt?: string
      messageLogName?: string
    }
    expect(props.initialPrompt).toBe('hello')
    expect(props.messageLogName).toBe('log')
    expect(capturedOptions?.exitOnCtrlC).toBe(false)
  })
})
