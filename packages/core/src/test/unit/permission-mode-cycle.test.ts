import { beforeEach, describe, expect, test } from 'bun:test'
import { getNextPermissionMode } from '#core/types/PermissionMode'
import { __applyPermissionModeSideEffectsForTests } from '#ui-ink/contexts/PermissionContext'
import {
  __resetPermissionModeStateForTests,
  getPermissionModeForConversationKey,
} from '#core/utils/permissionModeState'
import { getGlobalConfig, saveGlobalConfig } from '#core/utils/config'
import type { ToolUseContext } from '#core/tooling/Tool'
import {
  getPlanModeSystemPromptAdditions,
  isPlanModeEnabled,
} from '#core/utils/planMode'

function makeContext(
  messageLogName: string,
  forkNumber: number,
): ToolUseContext {
  return {
    messageId: undefined,
    abortController: new AbortController(),
    readFileTimestamps: {},
    options: { messageLogName, forkNumber },
  }
}

describe('permission mode cycle parity (cycle order + side effects)', () => {
  beforeEach(() => {
    __resetPermissionModeStateForTests()
  })

  test('new conversations start in Edit mode', () => {
    expect(
      getPermissionModeForConversationKey({
        conversationKey: 'new-conversation:0',
        isBypassPermissionsModeAvailable: true,
      }),
    ).toBe('acceptEdits')
  })

  test('getNextPermissionMode matches expected ordering', () => {
    expect(getNextPermissionMode('acceptEdits')).toBe('plan')
    expect(getNextPermissionMode('plan')).toBe('cautious')
    expect(getNextPermissionMode('cautious')).toBe('acceptEdits')
  })

  test('cycle into plan records lastPlanModeUse + enables plan mode', () => {
    const messageLogName = 'perm-cycle-plan'
    const forkNumber = 0
    const conversationKey = `${messageLogName}:${forkNumber}`

    saveGlobalConfig({ ...getGlobalConfig(), lastPlanModeUse: 0 })

    __applyPermissionModeSideEffectsForTests({
      conversationKey,
      previousMode: 'acceptEdits',
      nextMode: 'plan',
      recordPlanModeUse: true,
      now: () => 12345,
    })

    expect(
      getPermissionModeForConversationKey({
        conversationKey,
        isBypassPermissionsModeAvailable: true,
      }),
    ).toBe('plan')
    expect(isPlanModeEnabled(makeContext(messageLogName, forkNumber))).toBe(
      true,
    )
    expect(getGlobalConfig().lastPlanModeUse).toBe(12345)
  })

  test('setMode into plan does NOT record lastPlanModeUse (only shortcut cycle does)', () => {
    const messageLogName = 'perm-set-plan'
    const forkNumber = 0
    const conversationKey = `${messageLogName}:${forkNumber}`

    saveGlobalConfig({ ...getGlobalConfig(), lastPlanModeUse: 0 })

    __applyPermissionModeSideEffectsForTests({
      conversationKey,
      previousMode: 'acceptEdits',
      nextMode: 'plan',
      recordPlanModeUse: false,
      now: () => 999,
    })

    expect(isPlanModeEnabled(makeContext(messageLogName, forkNumber))).toBe(
      true,
    )
    expect(getGlobalConfig().lastPlanModeUse).toBe(0)
  })

  test('leaving plan sets plan_mode_exit attachment flags (one-shot reminder)', () => {
    const messageLogName = 'perm-exit-plan'
    const forkNumber = 0
    const conversationKey = `${messageLogName}:${forkNumber}`
    const ctx = makeContext(messageLogName, forkNumber)

    __applyPermissionModeSideEffectsForTests({
      conversationKey,
      previousMode: 'acceptEdits',
      nextMode: 'plan',
      recordPlanModeUse: false,
    })

    expect(isPlanModeEnabled(ctx)).toBe(true)

    __applyPermissionModeSideEffectsForTests({
      conversationKey,
      previousMode: 'plan',
      nextMode: 'acceptEdits',
      recordPlanModeUse: false,
    })

    expect(isPlanModeEnabled(ctx)).toBe(false)

    const first = getPlanModeSystemPromptAdditions([], ctx)
    expect(first.length).toBeGreaterThan(0)
    expect(first.join('\n')).toContain('Exited Plan Mode')

    const second = getPlanModeSystemPromptAdditions([], ctx)
    expect(second).toEqual([])
  })
})
