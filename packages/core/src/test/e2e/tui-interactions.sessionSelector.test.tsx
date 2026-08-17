import { afterEach, describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { KeypressProvider } from '#ui-ink/contexts/KeypressContext'
import type { KodeAgentSessionListItem } from '#protocol/utils/kodeAgentSessionResume'
import { createInkHarnessManager, createInkTestHarness } from './inkTestHarness'

const harnessManager = createInkHarnessManager()

const session: KodeAgentSessionListItem = {
  sessionId: 'session-1',
  slug: 'saved-session',
  customTitle: null,
  tag: null,
  summary: 'A saved conversation',
  gitBranch: null,
  forkedFromSessionId: null,
  forkRootSessionId: null,
  firstPrompt: null,
  messageExcerpt: null,
  messageCount: 1,
  cwd: '/tmp/project',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  modifiedAt: new Date('2026-01-01T00:00:00.000Z'),
}

afterEach(async () => {
  await harnessManager.cleanup()
  mock.restore()
})

describe('TUI E2E regression (Ink render): session selector', () => {
  test('shows progress while a session selection is pending and recovers on failure', async () => {
    let attempts = 0
    let rejectSelection: ((reason: Error) => void) | undefined

    mock.module('#core/utils/log', () => ({
      formatDate: () => 'today',
      logError: () => {},
    }))
    const { SessionSelector } =
      await import('#ui-ink/components/SessionSelector')

    const h = createInkTestHarness(
      <KeypressProvider>
        <SessionSelector
          sessions={[session]}
          onSelect={() => {
            attempts += 1
            if (attempts > 1) return
            return new Promise<void>((_resolve, reject) => {
              rejectSelection = reject
            })
          }}
        />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(50)
    h.stdin.write('\r')
    await h.wait(25)
    expect(h.getOutput()).toContain('Resuming conversation…')
    expect(rejectSelection).toBeDefined()

    if (!rejectSelection) throw new Error('Session selection did not start')
    h.clearOutput()
    rejectSelection(new Error('Session storage is temporarily unavailable'))
    await h.wait(50)

    expect(h.getOutput()).toContain(
      'Session storage is temporarily unavailable',
    )

    h.stdin.write('\r')
    await h.wait(25)
    expect(attempts).toBe(2)
  })
})
