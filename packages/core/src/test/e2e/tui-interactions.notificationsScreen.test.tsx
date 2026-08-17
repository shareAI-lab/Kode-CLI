import { afterEach, describe, expect, mock, test } from 'bun:test'
import React from 'react'

import { KeypressProvider } from '#ui-ink/contexts/KeypressContext'
import { createInkHarnessManager, createInkTestHarness } from './inkTestHarness'

const harnessManager = createInkHarnessManager()

afterEach(async () => {
  await harnessManager.cleanup()
  mock.restore()
})

function mockNotifications(): void {
  mock.module('node:fs', () => ({
    mkdirSync: () => {},
    writeFileSync: () => {},
  }))
  mock.module('#core/services/notificationCenter', () => ({
    clearNotifications: () => {},
    getNotifications: () => [
      {
        id: 'notification-1',
        createdAt: 0,
        message: 'test notification',
      },
    ],
    subscribeNotifications: () => () => {},
  }))
}

describe('TUI E2E regression (Ink render): NotificationsScreen', () => {
  test('starts one editor launch for rapid shortcuts and ignores completion after unmount', async () => {
    let launches = 0
    let resolveEditor:
      ((value: { ok: true; editorLabel: string }) => void) | null = null
    const finishEditor = (): void => {
      resolveEditor?.({ ok: true, editorLabel: 'test-editor' })
    }

    mockNotifications()
    mock.module('#cli-utils/externalEditor', () => ({
      launchExternalEditorForFilePath: () => {
        launches += 1
        return new Promise<{ ok: true; editorLabel: string }>(resolve => {
          resolveEditor = resolve
        })
      },
    }))

    const { NotificationsScreen } =
      await import('#ui-ink/screens/overlays/NotificationsScreen')
    const h = createInkTestHarness(
      <KeypressProvider>
        <NotificationsScreen onDone={() => {}} />
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
    mockNotifications()
    mock.module('#cli-utils/externalEditor', () => ({
      launchExternalEditorForFilePath: async () => {
        throw new Error('temporary editor failure')
      },
    }))

    const { NotificationsScreen } =
      await import('#ui-ink/screens/overlays/NotificationsScreen')
    const h = createInkTestHarness(
      <KeypressProvider>
        <NotificationsScreen onDone={() => {}} />
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
