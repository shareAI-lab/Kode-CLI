import { afterEach, describe, expect, test } from 'bun:test'
import React, { useEffect } from 'react'
import { Text } from 'ink'
import { createUserMessage } from '#core/utils/messages'
import type { Message } from '#core/query'
import { useMessageSelectorSelect } from '#ui-ink/screens/REPL/useMessageSelectorSelect'
import { createInkHarnessManager, createInkTestHarness } from './inkTestHarness'

const harnessManager = createInkHarnessManager()

afterEach(async () => {
  await harnessManager.cleanup()
})

describe('TUI E2E regression (Ink render): message selector', () => {
  test('cancels a deferred fork when the selector unmounts', async () => {
    const message = createUserMessage('selected prompt')
    const forks: unknown[] = []
    const inputs: string[] = []
    let cancelCount = 0
    const selectRef = {
      current: null as ((message: Message) => void) | null,
    }

    function MessageSelectorHarness(): React.ReactNode {
      const select = useMessageSelectorSelect({
        messages: [message],
        setIsMessageSelectorVisible: () => {},
        setForkConvoWithMessagesOnTheNextRender: (nextMessages, options) => {
          forks.push({ nextMessages, options })
        },
        setInputValue: value => {
          inputs.push(typeof value === 'function' ? value('') : value)
        },
        onCancel: () => {
          cancelCount += 1
        },
      })

      useEffect(() => {
        selectRef.current = select
      }, [select])

      return <Text>message-selector</Text>
    }

    const h = createInkTestHarness(<MessageSelectorHarness />)
    harnessManager.track(h)
    await h.wait(25)

    selectRef.current?.(message)
    h.unmount()

    await h.wait(25)
    expect(cancelCount).toBe(1)
    expect(forks).toEqual([])
    expect(inputs).toEqual([])
  })
})
