import { describe, expect, test } from 'bun:test'
import { shouldHandleCancelRequest } from './useCancelRequest'

describe('request cancellation', () => {
  test('accepts an active, non-aborted request', () => {
    expect(
      shouldHandleCancelRequest({
        wantsCancel: true,
        isLoading: true,
        isMessageSelectorVisible: false,
        abortSignal: new AbortController().signal,
      }),
    ).toBe(true)
  })

  test('does not intercept keys without a cancellable active request', () => {
    const aborted = new AbortController()
    aborted.abort()

    for (const args of [
      {
        wantsCancel: false,
        isLoading: true,
        abortSignal: new AbortController().signal,
      },
      {
        wantsCancel: true,
        isLoading: false,
        abortSignal: new AbortController().signal,
      },
      { wantsCancel: true, isLoading: true, abortSignal: undefined },
      { wantsCancel: true, isLoading: true, abortSignal: aborted.signal },
    ]) {
      expect(
        shouldHandleCancelRequest({
          ...args,
          isMessageSelectorVisible: false,
        }),
      ).toBe(false)
    }
  })

  test('leaves Escape available to close the message selector', () => {
    expect(
      shouldHandleCancelRequest({
        wantsCancel: true,
        isLoading: true,
        isMessageSelectorVisible: true,
        abortSignal: new AbortController().signal,
      }),
    ).toBe(false)
  })
})
