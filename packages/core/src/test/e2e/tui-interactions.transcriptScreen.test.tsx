import { afterEach, describe, expect, mock, test } from 'bun:test'
import React from 'react'

import { KeypressProvider } from '#ui-ink/contexts/KeypressContext'
import { createInkHarnessManager, createInkTestHarness } from './inkTestHarness'

const harnessManager = createInkHarnessManager()

async function waitForOutput(
  harness: ReturnType<typeof createInkTestHarness>,
  expected: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (harness.getOutput().includes(expected)) return
    await harness.wait(25)
  }

  throw new Error(
    `Timed out waiting for ${expected}: ${harness.getOutput().slice(-4_000)}`,
  )
}

afterEach(async () => {
  await harnessManager.cleanup()
  mock.restore()
})

function mockTranscriptDependencies(): void {
  mock.module('node:fs', () => ({
    mkdirSync: () => {},
    writeFileSync: () => {},
  }))
  mock.module('#core/messages', () => ({
    getMessagesGetter: () => () => [],
  }))
}

describe('TUI E2E regression (Ink render): TranscriptScreen', () => {
  test('starts one editor launch for rapid shortcuts and ignores completion after unmount', async () => {
    let launches = 0
    let resolveEditor:
      ((value: { ok: true; editorLabel: string }) => void) | null = null
    const finishEditor = (): void => {
      resolveEditor?.({ ok: true, editorLabel: 'test-editor' })
    }

    mockTranscriptDependencies()
    mock.module('#cli-utils/externalEditor', () => ({
      launchExternalEditorForFilePath: () => {
        launches += 1
        return new Promise<{ ok: true; editorLabel: string }>(resolve => {
          resolveEditor = resolve
        })
      },
    }))

    const { TranscriptScreen } =
      await import('#ui-ink/screens/overlays/TranscriptScreen')
    const h = createInkTestHarness(
      <KeypressProvider>
        <TranscriptScreen onDone={() => {}} />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await waitForOutput(h, 'Transcript')
    h.stdin.write('o')
    h.stdin.write('o')
    await waitForOutput(h, 'Opening external editor…')

    expect(launches).toBe(1)
    expect(h.getOutput()).toContain('Opening external editor…')

    h.unmount()
    finishEditor()
    await h.wait(25)
  })

  test('reports unexpected editor launcher failures', async () => {
    mockTranscriptDependencies()
    mock.module('#cli-utils/externalEditor', () => ({
      launchExternalEditorForFilePath: async () => {
        throw new Error('temporary editor failure')
      },
    }))

    const { TranscriptScreen } =
      await import('#ui-ink/screens/overlays/TranscriptScreen')
    const h = createInkTestHarness(
      <KeypressProvider>
        <TranscriptScreen onDone={() => {}} />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await waitForOutput(h, 'Transcript')
    h.stdin.write('o')
    await waitForOutput(
      h,
      'Unable to open the external editor. Check $EDITOR and try again.',
    )

    expect(h.getOutput()).toContain(
      'Unable to open the external editor. Check $EDITOR and try again.',
    )
  })

  test('starts one clipboard copy for rapid shortcuts and ignores completion after unmount', async () => {
    let copies = 0
    let resolveCopy:
      ((value: { method: 'system'; truncated: false }) => void) | null = null
    const finishCopy = (): void => {
      resolveCopy?.({ method: 'system', truncated: false })
    }

    mockTranscriptDependencies()
    mock.module('#cli-utils/clipboard', () => ({
      copyTextToClipboard: () => {
        copies += 1
        return new Promise<{ method: 'system'; truncated: false }>(resolve => {
          resolveCopy = resolve
        })
      },
    }))

    const { TranscriptScreen } =
      await import('#ui-ink/screens/overlays/TranscriptScreen')
    const h = createInkTestHarness(
      <KeypressProvider>
        <TranscriptScreen onDone={() => {}} />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await waitForOutput(h, 'Transcript')
    h.stdin.write('y')
    h.stdin.write('y')
    await waitForOutput(h, 'Copying transcript to clipboard…')

    expect(copies).toBe(1)

    h.unmount()
    finishCopy()
    await h.wait(25)
  })

  test('reports clipboard failures and allows another copy', async () => {
    let copies = 0

    mockTranscriptDependencies()
    mock.module('#cli-utils/clipboard', () => ({
      copyTextToClipboard: async () => {
        copies += 1
        throw new Error('clipboard unavailable')
      },
    }))

    const { TranscriptScreen } =
      await import('#ui-ink/screens/overlays/TranscriptScreen')
    const h = createInkTestHarness(
      <KeypressProvider>
        <TranscriptScreen onDone={() => {}} />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await waitForOutput(h, 'Transcript')
    h.stdin.write('y')
    await waitForOutput(h, 'Copy failed: clipboard unavailable')

    expect(copies).toBe(1)

    h.stdin.write('y')
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && copies !== 2) await h.wait(25)
    expect(copies).toBe(2)
  })
})
