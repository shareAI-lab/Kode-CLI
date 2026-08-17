import { afterEach, describe, expect, mock, test } from 'bun:test'
import React, { useEffect, useRef } from 'react'
import { Text } from 'ink'
import { KeypressProvider } from '#ui-ink/contexts/KeypressContext'
import { createInkHarnessManager, createInkTestHarness } from './inkTestHarness'

const harnessManager = createInkHarnessManager()

afterEach(async () => {
  await harnessManager.cleanup()
  mock.restore()
})

describe('TUI E2E regression (Ink render): Connection testing', () => {
  test('leaving the test screen ignores a late success and delayed navigation', async () => {
    let resolveTest:
      ((result: { success: true; message: string }) => void) | undefined
    let navigateAfterSuccess: ((screen: 'confirmation') => void) | undefined

    mock.module(
      '#ui-ink/components/ModelSelector/flow/actions/connectionTest',
      () => ({
        runConnectionTestFlow: ({
          navigateTo,
        }: {
          navigateTo: typeof navigateAfterSuccess
        }) => {
          navigateAfterSuccess = navigateTo
          return new Promise<{ success: true; message: string }>(resolve => {
            resolveTest = resolve
          })
        },
      }),
    )

    const { useModelSelectorActions } =
      await import('#ui-ink/components/ModelSelector/useModelSelectorActions')
    const { useModelSelectorState } =
      await import('#ui-ink/components/ModelSelector/useModelSelectorState')

    let actions: ReturnType<typeof useModelSelectorActions> | undefined

    function ConnectionTestHarness(): React.ReactNode {
      const state = useModelSelectorState({ skipModelType: false })
      const openedConnectionTestRef = useRef(false)
      const controller = useModelSelectorActions({
        props: { onDone: () => {} },
        state,
        onDone: () => {},
      })

      useEffect(() => {
        actions = controller
      }, [controller])
      useEffect(() => {
        if (openedConnectionTestRef.current) return
        openedConnectionTestRef.current = true
        state.navigateTo('connectionTest')
      }, [state])

      return <Text>screen:{state.currentScreen}</Text>
    }

    const h = createInkTestHarness(
      <KeypressProvider>
        <ConnectionTestHarness />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(75)
    expect(h.getOutput()).toContain('screen:connectionTest')
    expect(actions).toBeDefined()

    void actions?.handleConnectionTest()
    await h.wait(25)
    expect(resolveTest).toBeDefined()

    actions?.handleBack()
    await h.wait(50)
    expect(h.getOutput()).toContain('screen:provider')

    if (!resolveTest || !navigateAfterSuccess) {
      throw new Error('Connection test did not start')
    }
    resolveTest({ success: true, message: 'Connection succeeded' })
    navigateAfterSuccess('confirmation')
    await h.wait(50)

    expect(h.getOutput()).toContain('screen:provider')
    expect(h.getOutput()).not.toContain('screen:confirmation')
  })
})
