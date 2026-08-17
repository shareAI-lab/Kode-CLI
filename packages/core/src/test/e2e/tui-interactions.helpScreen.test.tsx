import { afterEach, describe, expect, mock, test } from 'bun:test'
import React from 'react'

import { KeypressProvider } from '#ui-ink/contexts/KeypressContext'
import { createInkHarnessManager, createInkTestHarness } from './inkTestHarness'

const harnessManager = createInkHarnessManager()

async function waitFor(
  harness: ReturnType<typeof createInkTestHarness>,
  condition: () => boolean,
  description: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await harness.wait(25)
  }

  throw new Error(
    `Timed out waiting for ${description}: ${harness.getOutput().slice(-4_000)}`,
  )
}

afterEach(async () => {
  await harnessManager.cleanup()
  mock.restore()
})

describe('TUI E2E regression (Ink render): HelpScreen', () => {
  test('starts one clipboard copy for rapid shortcuts and ignores completion after unmount', async () => {
    let copies = 0
    let resolveCopy:
      ((value: { method: 'system'; truncated: false }) => void) | null = null
    const finishCopy = (): void => {
      resolveCopy?.({ method: 'system', truncated: false })
    }

    mock.module('#cli-utils/clipboard', () => ({
      copyTextToClipboard: () => {
        copies += 1
        return new Promise<{ method: 'system'; truncated: false }>(resolve => {
          resolveCopy = resolve
        })
      },
    }))

    const { HelpScreen } = await import('#ui-ink/screens/overlays/HelpScreen')
    const h = createInkTestHarness(
      <KeypressProvider>
        <HelpScreen commands={[]} onDone={() => {}} />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await waitFor(h, () => h.getOutput().includes('Help'), 'help view')
    h.stdin.write('y')
    h.stdin.write('y')
    await waitFor(
      h,
      () => h.getOutput().includes('Copying to clipboard…'),
      'copying status',
    )

    expect(copies).toBe(1)

    h.unmount()
    finishCopy()
    await h.wait(25)
  })

  test('reports clipboard failures and allows another copy', async () => {
    let copies = 0

    mock.module('#cli-utils/clipboard', () => ({
      copyTextToClipboard: async () => {
        copies += 1
        throw new Error('clipboard unavailable')
      },
    }))

    const { HelpScreen } = await import('#ui-ink/screens/overlays/HelpScreen')
    const h = createInkTestHarness(
      <KeypressProvider>
        <HelpScreen commands={[]} onDone={() => {}} />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await waitFor(h, () => h.getOutput().includes('Help'), 'help view')
    h.stdin.write('y')
    await waitFor(
      h,
      () => h.getOutput().includes('Copy failed: clipboard unavailable'),
      'clipboard failure status',
    )

    expect(copies).toBe(1)

    h.stdin.write('y')
    await waitFor(h, () => copies === 2, 'retry copy call')
    expect(copies).toBe(2)
  })
})
