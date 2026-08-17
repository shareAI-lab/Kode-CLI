import { afterEach, describe, expect, mock, test } from 'bun:test'
import React from 'react'

import { KeypressProvider } from '#ui-ink/contexts/KeypressContext'
import { createInkHarnessManager, createInkTestHarness } from './inkTestHarness'

const harnessManager = createInkHarnessManager()

afterEach(async () => {
  await harnessManager.cleanup()
  mock.restore()
})

describe('TUI E2E regression (Ink render): StatusScreen', () => {
  test('starts only one connectivity check for rapid repeated shortcuts', async () => {
    let startedChecks = 0
    let resolveCheck:
      ((value: { success: boolean; message: string }) => void) | null = null
    const finishCheck = (value: {
      success: boolean
      message: string
    }): void => {
      resolveCheck?.(value)
    }

    mock.module('#core/utils/model', () => ({
      getModelManager: () => ({
        getModel: () => ({
          provider: 'openai',
          modelName: 'test-model',
          apiKey: 'test-key',
          maxTokens: 1024,
        }),
      }),
    }))
    mock.module(
      '#ui-ink/components/ModelSelector/flow/actions/connectionTest',
      () => ({
        performConnectionTest: () => {
          startedChecks += 1
          return new Promise<{ success: boolean; message: string }>(resolve => {
            resolveCheck = resolve
          })
        },
      }),
    )

    const { StatusScreen } =
      await import('#ui-ink/screens/overlays/StatusScreen')

    const h = createInkTestHarness(
      <KeypressProvider>
        <StatusScreen
          context={{ safeMode: false, options: {} } as any}
          onDone={() => {}}
        />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(50)
    h.stdin.write('c')
    h.stdin.write('c')
    await h.wait(50)

    expect(startedChecks).toBe(1)
    expect(h.getOutput()).toContain('Checking connectivity…')

    finishCheck({ success: true, message: 'ok' })
    await h.wait(25)
  })
})
