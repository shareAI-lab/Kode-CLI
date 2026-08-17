import { describe, expect, test } from 'bun:test'
import React from 'react'
import { useRef } from 'react'
import { render } from 'ink'
import { PassThrough } from 'node:stream'
import { useUndoBuffer } from './useUndoBuffer'

async function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function makeHarness(debounceMs: number) {
  const stdout = new PassThrough() as PassThrough & {
    isTTY?: boolean
    columns?: number
    rows?: number
  }
  stdout.isTTY = true
  stdout.columns = 80
  stdout.rows = 24

  const api: {
    push: (text: string) => void
    undo: () => string | null
    canUndo: () => boolean
  } = {
    push: () => {},
    undo: () => null,
    canUndo: () => false,
  }

  function Probe(): React.ReactNode {
    const buffer = useUndoBuffer<Record<string, never>>({
      maxBufferSize: 50,
      debounceMs,
    })
    const lastUndoRef = useRef<string | null>(null)
    api.push = (text: string) => {
      buffer.pushToBuffer({
        signature: `input:${text}`,
        text,
        cursorOffset: text.length,
        extra: {},
      })
    }
    api.undo = () => {
      const entry = buffer.undo()
      lastUndoRef.current = entry?.text ?? null
      return entry?.text ?? null
    }
    api.canUndo = () => buffer.canUndo
    return null
  }

  const instance = render(React.createElement(Probe), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    exitOnCtrlC: false,
  })

  return {
    push: (text: string) => api.push(text),
    undo: () => api.undo(),
    canUndo: () => api.canUndo(),
    unmount: () => instance.unmount(),
  }
}

describe('useUndoBuffer', () => {
  test('first entry flushes immediately so a fast burst stays undoable', async () => {
    const harness = makeHarness(200)

    // Empty input is the baseline, as the PromptInput effect pushes on mount.
    harness.push('')
    await wait(20)

    // Simulate a fast first burst: pushes within the debounce window, each
    // after a render tick like real keystrokes.
    harness.push('h')
    await wait(20)
    harness.push('he')
    await wait(20)
    harness.push('hel')
    await wait(20)
    harness.push('hello')

    // The first entry is committed immediately as the baseline; the burst
    // collapses into one additional entry after the debounce flush, so undo
    // can step back to the empty baseline.
    await wait(250)
    expect(harness.canUndo()).toBe(true)
    const undone = harness.undo()
    expect(undone).toBe('')

    harness.unmount()
  })

  test('slow typing produces one entry per push', async () => {
    const harness = makeHarness(10)

    harness.push('a')
    await wait(30)
    harness.push('ab')
    await wait(30)

    expect(harness.canUndo()).toBe(true)
    expect(harness.undo()).toBe('a')
    // Allow React to flush the undo state update before reading canUndo.
    await wait(20)
    expect(harness.canUndo()).toBe(false)
    expect(harness.undo()).toBeNull()

    harness.unmount()
  })
})
