import { describe, expect, test } from 'bun:test'
import {
  transitionToolUseConfirmQueue,
  transitionToolUseConfirmQueueClear,
} from './toolUseConfirmQueue'
import type { ToolUseConfirm } from '#ui-ink/components/permissions/PermissionRequest'

function makeConfirm(id: string): ToolUseConfirm {
  return {
    assistantMessage: { uuid: id } as never,
    tool: { name: `tool-${id}` } as never,
    description: '',
    input: {},
    commandPrefix: null,
    toolUseContext: {} as never,
    riskScore: null,
    onAbort() {},
    onAllow() {},
    onReject() {},
  }
}

describe('transitionToolUseConfirmQueue', () => {
  test('enqueues behind the head so the visible confirm is not clobbered', () => {
    const first = makeConfirm('a')
    const second = makeConfirm('b')

    const afterFirst = transitionToolUseConfirmQueue([], first)
    expect(afterFirst).toEqual([first])

    const afterSecond = transitionToolUseConfirmQueue(afterFirst, second)
    expect(afterSecond).toEqual([first, second])
  })

  test('popping the head reveals the next queued request', () => {
    const first = makeConfirm('a')
    const second = makeConfirm('b')
    const pending = transitionToolUseConfirmQueue(
      transitionToolUseConfirmQueue([], first),
      second,
    )

    const afterPop = transitionToolUseConfirmQueue(pending, null)
    expect(afterPop).toEqual([second])
  })

  test('popping an empty queue keeps it empty', () => {
    expect(transitionToolUseConfirmQueue([], null)).toEqual([])
  })
})

describe('transitionToolUseConfirmQueueClear', () => {
  test('clears the whole queue including the head', () => {
    const first = makeConfirm('a')
    const second = makeConfirm('b')
    const pending = transitionToolUseConfirmQueue(
      transitionToolUseConfirmQueue([], first),
      second,
    )

    expect(transitionToolUseConfirmQueueClear(pending)).toEqual([])
  })

  test('clearing an empty queue is a no-op', () => {
    expect(transitionToolUseConfirmQueueClear([])).toEqual([])
  })
})
