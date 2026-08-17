import { afterEach, describe, expect, mock, test } from 'bun:test'
import React from 'react'

import { KeypressProvider } from '#ui-ink/contexts/KeypressContext'
import { createInkHarnessManager, createInkTestHarness } from './inkTestHarness'

const harnessManager = createInkHarnessManager()

afterEach(async () => {
  await harnessManager.cleanup()
  mock.restore()
})

function mockCapturedConsoleOutput(): void {
  mock.module('#cli-utils/stdio', () => ({
    clearCapturedTuiStdio: () => {},
    flushCapturedTuiStdioToFile: () => '/tmp/kode-console-output.log',
    getCapturedTuiStdioLogPath: () => '/tmp/kode-console-output.log',
    getCapturedTuiStdioText: () => 'captured output',
  }))
}

describe('TUI E2E regression (Ink render): ConsoleScreen', () => {
  test('starts one editor launch for rapid shortcuts and ignores completion after unmount', async () => {
    let launches = 0
    let resolveEditor:
      ((value: { ok: true; editorLabel: string }) => void) | null = null
    const finishEditor = (): void => {
      resolveEditor?.({ ok: true, editorLabel: 'test-editor' })
    }

    mockCapturedConsoleOutput()
    mock.module('#cli-utils/externalEditor', () => ({
      launchExternalEditorForFilePath: () => {
        launches += 1
        return new Promise<{ ok: true; editorLabel: string }>(resolve => {
          resolveEditor = resolve
        })
      },
    }))

    const { ConsoleScreen } =
      await import('#ui-ink/screens/overlays/ConsoleScreen')
    const h = createInkTestHarness(
      <KeypressProvider>
        <ConsoleScreen onDone={() => {}} />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(50)
    h.stdin.write('o')
    h.stdin.write('o')
    await h.wait(50)

    expect(launches).toBe(1)
    expect(h.getOutput()).toContain('Opening external editor…')

    h.unmount()
    finishEditor()
    await h.wait(25)
  })

  test('reports unexpected editor launcher failures', async () => {
    mockCapturedConsoleOutput()
    mock.module('#cli-utils/externalEditor', () => ({
      launchExternalEditorForFilePath: async () => {
        throw new Error('temporary editor failure')
      },
    }))

    const { ConsoleScreen } =
      await import('#ui-ink/screens/overlays/ConsoleScreen')
    const h = createInkTestHarness(
      <KeypressProvider>
        <ConsoleScreen onDone={() => {}} />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(50)
    h.stdin.write('o')
    await h.wait(50)

    expect(h.getOutput()).toContain(
      'Unable to open the external editor. Check $EDITOR and try again.',
    )
  })
})
