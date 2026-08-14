import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GoalService, type Clock } from './index'

/**
 * Focused coverage for the one-second host polling hot path
 * (GoalScheduleRunner / REPL tick): claim, unstarted discovery,
 * recovery, and the no-op cases. Mirrors the helper style of goals.test.ts.
 */

class TestClock implements Clock {
  constructor(public value: number) {}

  now(): number {
    return this.value
  }
}

const temporaryRoots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'kode-goals-poll-'))
  temporaryRoots.push(root)
  return root
}

function makeService(rootDir: string, clock: TestClock): GoalService {
  let nextId = 0
  return new GoalService({
    rootDir,
    clock,
    leaseDurationMs: 1_000,
    idFactory: () => `generated-${++nextId}`,
  })
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop()!
    rmSync(root, { recursive: true, force: true })
  }
})

describe('pollDueSchedule (host polling hot path)', () => {
  test('claims a due once-goal and reports source "claimed"', () => {
    const root = makeRoot()
    const clock = new TestClock(1_500)
    const service = makeService(root, clock)
    service.createGoal({
      id: 'poll-claimed',
      cwd: join(root, 'workspace'),
      sessionId: 'session-a',
      objective: 'Run a scheduled task',
      schedule: {
        kind: 'once',
        prompt: 'Execute the scheduled task.',
        runAt: 1_000,
      },
    })

    const result = service.pollDueSchedule({
      cwd: join(root, 'workspace'),
      sessionId: 'session-a',
      now: clock.now(),
    })
    expect(result?.source).toBe('claimed')
    expect(result?.schedule.runId).toBeTruthy()
    expect(result?.schedule.prompt).toBe('Execute the scheduled task.')

    const goal = service.getGoal('poll-claimed')
    expect(goal?.status).toBe('running')
    expect(goal?.activeRun?.turnCount).toBe(0)
    expect(goal?.lease?.runId).toBe(result?.schedule.runId)
  })

  test('reports an already-claimed, not-yet-started once run as "unstarted"', () => {
    const root = makeRoot()
    const clock = new TestClock(1_500)
    const service = makeService(root, clock)
    service.createGoal({
      id: 'poll-unstarted',
      cwd: join(root, 'workspace'),
      sessionId: 'session-a',
      objective: 'Direct start without a prompt',
      schedule: {
        kind: 'once',
        prompt: 'Start immediately.',
        runAt: 1_000,
      },
    })

    // Claim once (as a direct /goal call would), then poll: the run is
    // claimed but has not completed a turn, so it surfaces as "unstarted".
    const first = service.pollDueSchedule({
      cwd: join(root, 'workspace'),
      sessionId: 'session-a',
      now: clock.now(),
    })
    expect(first?.source).toBe('claimed')

    const second = service.pollDueSchedule({
      cwd: join(root, 'workspace'),
      sessionId: 'session-a',
      now: clock.now(),
    })
    expect(second?.source).toBe('unstarted')
    expect(second?.schedule.runId).toBe(first?.schedule.runId)

    // The poller is stable: repeated polls return the same unstarted run
    // instead of re-claiming, so the host's dedupe set stays effective.
    const third = service.pollDueSchedule({
      cwd: join(root, 'workspace'),
      sessionId: 'session-a',
      now: clock.now(),
    })
    expect(third?.schedule.runId).toBe(first?.schedule.runId)
  })

  test('returns null when nothing is due and no run is unstarted', () => {
    const root = makeRoot()
    const clock = new TestClock(500)
    const service = makeService(root, clock)
    service.createGoal({
      id: 'poll-future',
      cwd: join(root, 'workspace'),
      sessionId: 'session-a',
      objective: 'Later task',
      schedule: {
        kind: 'once',
        prompt: 'Run later.',
        runAt: 10_000,
      },
    })

    expect(
      service.pollDueSchedule({
        cwd: join(root, 'workspace'),
        sessionId: 'session-a',
        now: clock.now(),
      }),
    ).toBeNull()
  })

  test('recovers an expired lease and re-claims in one poll', () => {
    const root = makeRoot()
    const clock = new TestClock(1_500)
    const service = makeService(root, clock)
    service.createGoal({
      id: 'poll-recover',
      cwd: join(root, 'workspace'),
      sessionId: 'session-a',
      objective: 'Recover after a crash',
      schedule: {
        kind: 'once',
        prompt: 'Keep going.',
        runAt: 1_000,
      },
    })
    service.pollDueSchedule({
      cwd: join(root, 'workspace'),
      sessionId: 'session-a',
      now: 1_500,
    })

    // Lease expires after 1000ms; the next poll must recover and re-claim
    // exactly once, never leaving the goal stuck in 'running'. Recovery is
    // recorded on the event stream; the fresh claim clears lastError because
    // a new run is beginning.
    const recovered = service.pollDueSchedule({
      cwd: join(root, 'workspace'),
      sessionId: 'session-a',
      now: 3_000,
    })
    expect(recovered?.source).toBe('claimed')
    const goal = service.getGoal('poll-recover')
    expect(goal?.status).toBe('running')
    expect(goal?.lease?.runId).toBe(recovered?.schedule.runId)
    expect(goal?.activeRun?.turnCount).toBe(0)

    const events = service.listGoalEvents('poll-recover')
    expect(events.some(event => event.type === 'recovered')).toBe(true)
    expect(events.some(event => event.type === 'claimed')).toBe(true)
  })

  test('does not surface unstarted runs for interval schedules', () => {
    const root = makeRoot()
    const clock = new TestClock(1_500)
    const service = makeService(root, clock)
    service.createGoal({
      id: 'poll-interval',
      cwd: join(root, 'workspace'),
      sessionId: 'session-a',
      objective: 'Loop until green',
      schedule: {
        kind: 'interval',
        prompt: 'Check and continue.',
        everyMs: 100,
        anchorAt: 1_000,
      },
    })
    service.pollDueSchedule({
      cwd: join(root, 'workspace'),
      sessionId: 'session-a',
      now: 1_500,
    })

    // Interval run claimed and not yet turned: the unstarted path is
    // reserved for one-off direct runs, so the poll reports nothing.
    expect(
      service.pollDueSchedule({
        cwd: join(root, 'workspace'),
        sessionId: 'session-a',
        now: 1_500,
      }),
    ).toBeNull()
  })

  test('is scoped per workspace and session', () => {
    const root = makeRoot()
    const clock = new TestClock(1_500)
    const service = makeService(root, clock)
    service.createGoal({
      id: 'poll-other',
      cwd: join(root, 'workspace-a'),
      sessionId: 'session-a',
      objective: 'Other workspace task',
      schedule: {
        kind: 'once',
        prompt: 'Run.',
        runAt: 1_000,
      },
    })

    expect(
      service.pollDueSchedule({
        cwd: join(root, 'workspace-b'),
        sessionId: 'session-a',
        now: 1_500,
      }),
    ).toBeNull()
    expect(
      service.pollDueSchedule({
        cwd: join(root, 'workspace-a'),
        sessionId: 'session-b',
        now: 1_500,
      }),
    ).toBeNull()
    expect(
      service.pollDueSchedule({
        cwd: join(root, 'workspace-a'),
        sessionId: 'session-a',
        now: 1_500,
      }),
    ).not.toBeNull()
  })

  test('does not surface unstarted direct runs to a background-only poller', () => {
    const root = makeRoot()
    const clock = new TestClock(1_500)
    const service = makeService(root, clock)
    service.startGoal({
      cwd: join(root, 'workspace'),
      sessionId: 'session-bg-only',
      objective: 'Direct start',
      now: 1_500,
    })

    // A detached host must not pick up a direct run it could never claim:
    // backgroundOnly applies to the unstarted re-surface path as well.
    expect(
      service.pollDueSchedule({
        cwd: join(root, 'workspace'),
        sessionId: 'session-bg-only',
        now: 1_500,
        backgroundOnly: true,
      }),
    ).toBeNull()
    expect(
      service.pollDueSchedule({
        cwd: join(root, 'workspace'),
        sessionId: 'session-bg-only',
        now: 1_500,
      }),
    ).not.toBeNull()
  })
})
