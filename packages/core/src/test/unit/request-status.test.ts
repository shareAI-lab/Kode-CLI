import { afterEach, describe, expect, test } from 'bun:test'
import {
  FIRST_RESPONSE_WARNING_SECONDS,
  formatRequestStatusDuration,
  formatRequestStatusTokens,
  getRequestStatus,
  getRequestStatusLabel,
  getRequestStatusPhaseLabel,
  getRequestStatusTiming,
  shouldShowRequestStatusPhase,
  getRequestStatusTokenDisplay,
  REQUEST_STATUS_ESC_CANCEL_HINT,
  setRequestStatus,
  subscribeRequestStatus,
  updateRequestTokens,
  type RequestStatus,
} from '#core/utils/requestStatus'

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('request status token updates', () => {
  afterEach(() => {
    setRequestStatus({ kind: 'idle' })
  })

  test('coalesces bursty output token updates for subscribers', async () => {
    const seen: RequestStatus[] = []
    setRequestStatus({ kind: 'streaming' })
    const unsubscribe = subscribeRequestStatus(status => {
      seen.push({ ...status })
    })

    try {
      updateRequestTokens(1)
      updateRequestTokens(2)
      updateRequestTokens(3)

      expect(seen.map(status => status.outputTokens)).toEqual([1])
      expect(getRequestStatus().outputTokens).toBe(3)

      await wait(240)

      expect(seen.map(status => status.outputTokens)).toEqual([1, 3])
    } finally {
      unsubscribe()
    }
  })

  test('cancels a pending token notification when the request returns to idle', async () => {
    const seen: RequestStatus[] = []
    setRequestStatus({ kind: 'streaming' })
    const unsubscribe = subscribeRequestStatus(status => {
      seen.push({ ...status })
    })

    try {
      updateRequestTokens(1)
      updateRequestTokens(2)
      setRequestStatus({ kind: 'idle' })

      await wait(240)

      expect(seen.map(status => status.kind)).toEqual(['streaming', 'idle'])
      expect(seen.map(status => status.outputTokens)).toEqual([1, 2])
    } finally {
      unsubscribe()
    }
  })

  test('keeps request timing across phases and resets it when idle', () => {
    setRequestStatus({ kind: 'thinking' })
    const started = getRequestStatus()
    expect(started.startedAt).toBeDefined()
    expect(started.phaseStartedAt).toBeDefined()

    const timingWhileThinking = getRequestStatusTiming(started, 2_000)
    expect(
      getRequestStatusTiming(
        { ...started, startedAt: 1_000, phaseStartedAt: 1_500 },
        2_000,
      ),
    ).toEqual({
      requestDurationMs: 1_000,
      phaseDurationMs: 500,
      thinkingDurationMs: 500,
    })
    expect(timingWhileThinking.requestDurationMs).toBeGreaterThanOrEqual(0)

    setRequestStatus({ kind: 'tool', detail: 'Read' })
    const tool = getRequestStatus()
    expect(tool.startedAt).toBe(started.startedAt)
    expect(tool.phaseStartedAt).toBeDefined()
    expect(tool.thinkingDurationMs).toBeGreaterThanOrEqual(0)

    setRequestStatus({ kind: 'idle' })
    expect(getRequestStatus()).toMatchObject({ kind: 'idle' })
    expect(getRequestStatus().startedAt).toBeUndefined()
  })
})

describe('shared request status display helpers', () => {
  test('formats durations in s / m s / h m s', () => {
    expect(formatRequestStatusDuration(5)).toBe('5s')
    expect(formatRequestStatusDuration(125)).toBe('2m 5s')
    expect(formatRequestStatusDuration(3725)).toBe('1h 2m 5s')
    expect(formatRequestStatusDuration(-3)).toBe('0s')
  })

  test('formats token counts with the same rounding as the UI', () => {
    expect(formatRequestStatusTokens(0)).toBe('0')
    expect(formatRequestStatusTokens(999)).toBe('999')
    expect(formatRequestStatusTokens(12_500)).toBe('13k')
    expect(formatRequestStatusTokens(1_500_000)).toBe('1.5M')
  })

  test('labels every phase with consistent wording', () => {
    const base: RequestStatus = {
      kind: 'idle',
      updatedAt: 0,
      startedAt: 0,
      phaseStartedAt: 0,
    }
    expect(getRequestStatusLabel({ ...base, kind: 'waiting' }, 3)).toBe(
      'Waiting for model response',
    )
    expect(
      getRequestStatusLabel(
        { ...base, kind: 'waiting', detail: 'Capabilities: preparing audit' },
        3,
      ),
    ).toBe('Capabilities: preparing audit')
    expect(
      getRequestStatusLabel(
        { ...base, kind: 'waiting', detail: 'Preparing audit' },
        FIRST_RESPONSE_WARNING_SECONDS + 1,
      ),
    ).toBe('Preparing audit · waiting for first model response')
    expect(
      getRequestStatusLabel(
        { ...base, kind: 'waiting' },
        FIRST_RESPONSE_WARNING_SECONDS + 1,
      ),
    ).toBe('Waiting for model response')
    expect(getRequestStatusLabel({ ...base, kind: 'thinking' }, 1)).toBe(
      'Thinking',
    )
    expect(getRequestStatusLabel({ ...base, kind: 'streaming' }, 1)).toBe(
      'Writing response',
    )
    expect(getRequestStatusLabel({ ...base, kind: 'tool' }, 1)).toBe(
      'Working · running tool',
    )
    expect(
      getRequestStatusLabel({ ...base, kind: 'tool', detail: 'Bash' }, 1),
    ).toBe('Working · Bash')
    expect(getRequestStatusLabel({ ...base, kind: 'idle' }, 1)).toBe('')
  })

  test('shows live token counters only where the phase has them', () => {
    const base: RequestStatus = {
      kind: 'idle',
      updatedAt: 0,
      startedAt: 0,
      phaseStartedAt: 0,
    }
    expect(
      getRequestStatusTokenDisplay({
        ...base,
        kind: 'thinking',
        inputTokens: 12_500,
      }),
    ).toBe(' · ↑ 13k')
    expect(
      getRequestStatusTokenDisplay({
        ...base,
        kind: 'streaming',
        outputTokens: 4_200,
      }),
    ).toBe(' · ↓ 4k')
    expect(getRequestStatusTokenDisplay({ ...base, kind: 'tool' })).toBe('')
    expect(getRequestStatusTokenDisplay({ ...base, kind: 'idle' })).toBe('')
  })

  test('labels phase durations with per-phase verbs', () => {
    const base: RequestStatus = {
      kind: 'idle',
      updatedAt: 0,
      startedAt: 0,
      phaseStartedAt: 0,
    }
    expect(
      getRequestStatusPhaseLabel(
        { ...base, kind: 'waiting', startedAt: 0, phaseStartedAt: 0 },
        3_000,
      ),
    ).toBe('waiting 3s')
    expect(
      getRequestStatusPhaseLabel(
        { ...base, kind: 'thinking', startedAt: 0, phaseStartedAt: 0 },
        2_000,
      ),
    ).toBe('thinking 2s')
    expect(
      getRequestStatusPhaseLabel(
        { ...base, kind: 'streaming', startedAt: 0, phaseStartedAt: 0 },
        1_000,
      ),
    ).toBe('writing 1s')
    expect(
      getRequestStatusPhaseLabel(
        { ...base, kind: 'tool', startedAt: 0, phaseStartedAt: 0 },
        5_000,
      ),
    ).toBe('working 5s')
    expect(getRequestStatusPhaseLabel({ ...base, kind: 'idle' }, 1_000)).toBe(
      '',
    )
  })

  test('exposes the shared cancel affordance text', () => {
    expect(REQUEST_STATUS_ESC_CANCEL_HINT).toBe('(Esc to cancel)')
  })

  test('hides a phase chip that only restates the waiting label', () => {
    const waiting: RequestStatus = {
      kind: 'waiting',
      updatedAt: 0,
      startedAt: 0,
      phaseStartedAt: 0,
    }
    expect(shouldShowRequestStatusPhase(waiting, 15_000)).toBe(false)

    const thinkingAfterWait: RequestStatus = {
      kind: 'thinking',
      updatedAt: 20_000,
      startedAt: 0,
      phaseStartedAt: 18_000,
    }
    expect(shouldShowRequestStatusPhase(thinkingAfterWait, 20_000)).toBe(true)
  })
})
