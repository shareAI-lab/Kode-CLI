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

async function enterDescription(
  harness: ReturnType<typeof createInkTestHarness>,
): Promise<void> {
  for (const char of 'test bug') {
    harness.stdin.write(char)
    await harness.wait(20)
  }
  await waitFor(
    harness,
    () => harness.getOutput().includes('Enter to continue - Esc to cancel'),
    'description input',
  )
  harness.stdin.write('\r')
  await waitFor(
    harness,
    () =>
      harness.getOutput().includes('Enter to open GitHub and create an issue.'),
    'consent view',
  )
  await harness.wait(50)
}

afterEach(async () => {
  await harnessManager.cleanup()
  mock.restore()
})

describe('TUI E2E regression (Ink render): Bug report', () => {
  test('starts one browser launch for rapid confirms and ignores completion after unmount', async () => {
    let launches = 0
    const browser = {
      resolve: null as ((value: boolean) => void) | null,
    }
    const results: string[] = []

    mock.module('#core/utils/browser', () => ({
      openBrowser: () => {
        launches += 1
        return new Promise<boolean>(resolve => {
          browser.resolve = resolve
        })
      },
    }))

    const { Bug } = await import('#ui-ink/components/Bug')
    const h = createInkTestHarness(
      <KeypressProvider>
        <Bug onDone={result => results.push(result)} />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await waitFor(
      h,
      () => h.getOutput().includes('Submit Bug Report'),
      'bug view',
    )
    await enterDescription(h)
    h.stdin.write('\r')
    h.stdin.write('\r')
    await waitFor(
      h,
      () => h.getOutput().includes('Opening GitHub...'),
      'opening status',
    )

    expect(launches).toBe(1)

    h.unmount()
    browser.resolve?.(true)
    await h.wait(25)
    expect(results).toEqual([])
  })

  test('returns a manual issue URL when the browser launcher throws', async () => {
    const results: string[] = []

    mock.module('#core/utils/browser', () => ({
      openBrowser: async () => {
        throw new Error('browser unavailable')
      },
    }))

    const { Bug } = await import('#ui-ink/components/Bug')
    const h = createInkTestHarness(
      <KeypressProvider>
        <Bug onDone={result => results.push(result)} />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await waitFor(
      h,
      () => h.getOutput().includes('Submit Bug Report'),
      'bug view',
    )
    await enterDescription(h)
    h.stdin.write('\r')
    await waitFor(h, () => results.length === 1, 'browser failure result')

    expect(results[0]).toContain(
      'Failed to open browser. Open this URL manually:',
    )
    expect(results[0]).toContain('github.com')
  })
})
