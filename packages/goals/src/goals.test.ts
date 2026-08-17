import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  GoalService,
  GoalScheduler,
  GoalStorage,
  MAX_GOAL_CONTINUATIONS,
  claimDueSchedules,
  evaluateActiveGoalAfterTurn,
  getUnstartedGoalRunSchedule,
  startGoal,
  type Clock,
} from './index'

class TestClock implements Clock {
  constructor(public value: number) {}

  now(): number {
    return this.value
  }
}

const temporaryRoots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'kode-goals-'))
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

describe('durable goals', () => {
  test('persists a goal atomically at the KODE root and records events', () => {
    const root = makeRoot()
    const clock = new TestClock(1_000)
    const service = makeService(root, clock)
    const goal = service.createGoal({
      id: 'goal-persisted',
      cwd: join(root, 'workspace'),
      sessionId: 'session-a',
      objective: 'Ship a durable goal store',
      acceptanceCriteria: ['Goal can be loaded after a new process starts'],
      schedule: {
        kind: 'once',
        prompt: 'Implement the durable goal store.',
        runAt: 1_500,
      },
    })

    const restartedStore = new GoalStorage({ rootDir: root })
    const loaded = restartedStore.getGoal(goal.id)
    expect(loaded).not.toBeNull()
    expect(loaded?.objective).toBe(goal.objective)
    expect(loaded?.schedule.prompt).toBe('Implement the durable goal store.')
    expect(restartedStore.listEvents(goal.id)).toHaveLength(1)
    expect(restartedStore.listEvents(goal.id)[0]?.type).toBe('created')
  })

  test('claims a fixed interval once and skips all missed slots', () => {
    const root = makeRoot()
    const clock = new TestClock(1_350)
    const service = makeService(root, clock)
    const goal = service.createGoal({
      id: 'goal-interval',
      cwd: join(root, 'workspace'),
      sessionId: 'session-a',
      objective: 'Check CI until it is green',
      schedule: {
        kind: 'interval',
        prompt: 'Check CI and continue the active goal.',
        everyMs: 100,
        anchorAt: 1_000,
      },
    })

    const first = service.claimDueSchedules({
      cwd: goal.cwd,
      sessionId: goal.sessionId,
      now: clock.now(),
    })
    expect(first).toHaveLength(1)
    expect(first[0]?.prompt).toBe('Check CI and continue the active goal.')
    expect(service.getGoal(goal.id)?.schedule.nextRunAt).toBe(1_400)

    service.releaseAfterTurn(goal.id, {
      now: clock.now(),
      runId: service.getGoal(goal.id)?.activeRun?.id ?? '',
    })
    expect(
      service.claimDueSchedules({
        cwd: goal.cwd,
        sessionId: goal.sessionId,
        now: 1_399,
      }),
    ).toHaveLength(0)
    expect(
      service.claimDueSchedules({
        cwd: goal.cwd,
        sessionId: goal.sessionId,
        now: 1_400,
      }),
    ).toHaveLength(1)
  })

  test('exhausts an interval instead of persisting an unsafe timestamp', () => {
    const root = makeRoot()
    const service = makeService(root, new TestClock(1))
    const goal = service.createGoal({
      id: 'goal-overflow-safe',
      cwd: join(root, 'workspace'),
      sessionId: 'session-overflow-safe',
      objective: 'Keep persisted timestamps safe',
      schedule: {
        kind: 'interval',
        prompt: 'Run once before the timestamp overflows.',
        everyMs: Number.MAX_SAFE_INTEGER,
        anchorAt: 1,
      },
    })

    expect(
      service.claimDueSchedules({
        cwd: goal.cwd,
        sessionId: goal.sessionId,
        now: 1,
      }),
    ).toHaveLength(1)
    const running = service.getGoal(goal.id)
    expect(running?.schedule.nextRunAt).toBeNull()
    expect(running?.status).toBe('running')
  })

  test('consumes a one-off schedule exactly once unless an interrupted lease is recovered', () => {
    const root = makeRoot()
    const clock = new TestClock(1_000)
    const service = makeService(root, clock)
    const goal = service.createGoal({
      id: 'goal-once',
      cwd: join(root, 'workspace'),
      sessionId: 'session-a',
      objective: 'Run the one-off migration review',
      schedule: {
        kind: 'once',
        prompt: 'Review migration status.',
        runAt: 1_000,
      },
    })

    expect(
      service.claimDueSchedules({
        cwd: goal.cwd,
        sessionId: goal.sessionId,
        now: 1_000,
      }),
    ).toHaveLength(1)
    service.releaseAfterTurn(goal.id, {
      now: 1_001,
      runId: service.getGoal(goal.id)?.activeRun?.id ?? '',
    })
    expect(service.getGoal(goal.id)?.status).toBe('paused')
    expect(
      service.claimDueSchedules({
        cwd: goal.cwd,
        sessionId: goal.sessionId,
        now: 9_000,
      }),
    ).toHaveLength(0)
  })

  test('recovers an expired lease as one retry without duplicate claims', () => {
    const root = makeRoot()
    const clock = new TestClock(1_000)
    const service = makeService(root, clock)
    const goal = service.createGoal({
      id: 'goal-recovery',
      cwd: join(root, 'workspace'),
      sessionId: 'session-a',
      objective: 'Recover an interrupted run',
      schedule: {
        kind: 'once',
        prompt: 'Continue after recovery.',
        runAt: 1_000,
      },
    })

    expect(
      service.claimDueSchedules({
        cwd: goal.cwd,
        sessionId: goal.sessionId,
        now: 1_000,
      }),
    ).toHaveLength(1)
    const recovered = service.recoverInterruptedGoals({ now: 2_001 })
    expect(recovered.map(item => item.id)).toEqual([goal.id])
    expect(service.getGoal(goal.id)?.status).toBe('scheduled')

    expect(
      service.claimDueSchedules({
        cwd: goal.cwd,
        sessionId: goal.sessionId,
        now: 2_001,
      }),
    ).toHaveLength(1)
    expect(
      service.claimDueSchedules({
        cwd: goal.cwd,
        sessionId: goal.sessionId,
        now: 2_001,
      }),
    ).toHaveLength(0)
  })

  test('top-level scheduler claim is root-scoped, prompt-carrying, and atomic', () => {
    const root = makeRoot()
    const clock = new TestClock(5_000)
    const service = makeService(root, clock)
    const goal = service.createGoal({
      id: 'goal-scheduler',
      cwd: join(root, 'workspace'),
      sessionId: 'session-a',
      objective: 'Wake a session',
      schedule: {
        kind: 'once',
        prompt: 'Wake and inspect the goal.',
        runAt: 5_000,
      },
    })

    const first = claimDueSchedules({
      rootDir: root,
      cwd: goal.cwd,
      sessionId: goal.sessionId,
      now: 5_000,
      leaseDurationMs: 1_000,
    })
    expect(first).toHaveLength(1)
    expect(first[0]?.goalId).toBe(goal.id)
    expect(first[0]?.prompt).toBe('Wake and inspect the goal.')
    expect(
      claimDueSchedules({
        rootDir: root,
        cwd: goal.cwd,
        sessionId: goal.sessionId,
        now: 5_000,
      }),
    ).toHaveLength(0)
  })

  test('startGoal is immediately session-active and evaluator injection controls the loop', async () => {
    const root = makeRoot()
    const cwd = join(root, 'workspace')
    const goal = startGoal({
      rootDir: root,
      cwd,
      sessionId: 'session-goal',
      objective: 'Finish the release checklist',
      acceptanceCriteria: ['All checks are evidenced'],
      maxIterations: 2,
      now: 10_000,
    })
    expect(goal.status).toBe('running')

    const continued = await evaluateActiveGoalAfterTurn({
      rootDir: root,
      cwd,
      sessionId: 'session-goal',
      assistantText: 'I have started.',
      now: 10_001,
      evaluate: async () => ({
        action: 'continue',
        reason: 'Tests still need to run.',
        continuationPrompt: 'Run the focused tests and report their evidence.',
      }),
    })
    expect(continued.action).toBe('continue')
    expect(continued.continuationPrompt).toBe(
      'Run the focused tests and report their evidence.',
    )
    expect(continued.goal?.activeRun?.turnCount).toBe(1)

    const completed = await evaluateActiveGoalAfterTurn({
      rootDir: root,
      cwd,
      sessionId: 'session-goal',
      assistantText: 'Focused tests passed with evidence.',
      now: 10_002,
      evaluate: async () => ({
        action: 'complete',
        reason: 'All checks evidenced.',
      }),
    })
    expect(completed.action).toBe('complete')
    expect(completed.goal?.status).toBe('completed')
  })

  test('forwards bounded verification evidence to a goal evaluator', async () => {
    const root = makeRoot()
    const cwd = join(root, 'workspace')
    startGoal({
      rootDir: root,
      cwd,
      sessionId: 'session-evidence',
      objective: 'Run a checked release step',
    })
    const verificationEvidence = [
      {
        version: 1 as const,
        kind: 'test' as const,
        status: 'passed' as const,
        toolUseId: 'verify-1',
        commandDigest: 'a'.repeat(16),
        outputDigest: 'b'.repeat(16),
        recordedAt: '2026-08-10T00:00:00.000Z',
      },
    ]
    let observedEvidence: unknown

    const result = await evaluateActiveGoalAfterTurn({
      rootDir: root,
      cwd,
      sessionId: 'session-evidence',
      assistantText: 'The focused test passed.',
      verificationEvidence,
      evaluate: async input => {
        observedEvidence = input.verificationEvidence
        return { action: 'complete', reason: 'Evidence received.' }
      },
    })

    expect(observedEvidence).toEqual(verificationEvidence)
    expect(result.action).toBe('complete')
  })

  test('bounds evaluator output and fails closed on an invalid decision', async () => {
    const root = makeRoot()
    const cwd = join(root, 'workspace')
    const service = new GoalService({ rootDir: root })
    const first = service.startGoal({
      cwd,
      sessionId: 'session-invalid-decision',
      objective: 'Reject an invalid evaluator action',
    })
    const invalid = await evaluateActiveGoalAfterTurn({
      rootDir: root,
      cwd,
      sessionId: first.sessionId,
      assistantText: 'Work is ambiguous.',
      evaluate: async () => ({ action: 'invented' }) as never,
    })
    expect(invalid).toMatchObject({
      action: 'paused',
      reason: 'Goal evaluator returned an invalid decision.',
    })

    const second = service.startGoal({
      cwd,
      sessionId: 'session-bounded-decision',
      objective: 'Bound evaluator output',
    })
    const completed = await evaluateActiveGoalAfterTurn({
      rootDir: root,
      cwd,
      sessionId: second.sessionId,
      assistantText: 'Done.',
      evaluate: async () => ({
        action: 'complete',
        reason: 'x'.repeat(10_000),
      }),
    })
    expect(completed.action).toBe('complete')
    expect(completed.reason).toHaveLength(4_000)
    expect(service.storage.listEvents(second.id).at(-1)?.message).toHaveLength(
      4_000,
    )
  })

  test('exposes an unstarted direct goal to an interactive dispatcher', () => {
    const root = makeRoot()
    const goal = startGoal({
      rootDir: root,
      cwd: join(root, 'workspace'),
      sessionId: 'session-dispatch',
      objective: 'Start the first goal turn',
      now: 10_000,
    })

    expect(getUnstartedGoalRunSchedule(goal)).toMatchObject({
      goalId: goal.id,
      prompt: 'Start the first goal turn',
      runId: goal.activeRun?.id,
    })

    const continued = new GoalService({ rootDir: root }).recordContinuation(
      goal.id,
      { runId: goal.activeRun?.id ?? '' },
    )
    expect(getUnstartedGoalRunSchedule(continued)).toBeNull()
  })

  test('fences a stale evaluator from completing a reclaimed GoalRun', async () => {
    const root = makeRoot()
    const cwd = join(root, 'workspace')
    const clock = new TestClock(1_000)
    const service = makeService(root, clock)
    const started = service.startGoal({
      cwd,
      sessionId: 'session-fence',
      objective: 'Keep the reclaimed run intact',
    })
    const oldRunId = started.activeRun?.id

    let resolveEvaluation!: (value: {
      action: 'complete'
      reason: string
    }) => void
    let markEvaluationStarted!: () => void
    const evaluationStarted = new Promise<void>(resolve => {
      markEvaluationStarted = resolve
    })
    const delayedDecision = new Promise<{ action: 'complete'; reason: string }>(
      resolve => {
        resolveEvaluation = resolve
      },
    )
    const evaluation = evaluateActiveGoalAfterTurn({
      rootDir: root,
      cwd,
      sessionId: 'session-fence',
      assistantText: 'The first run is still evaluating.',
      now: 1_000,
      leaseDurationMs: 1_000,
      evaluate: async () => {
        markEvaluationStarted()
        return delayedDecision
      },
    })
    await evaluationStarted

    expect(
      service.recoverInterruptedGoals({
        cwd,
        sessionId: 'session-fence',
        now: 2_001,
      }),
    ).toHaveLength(1)
    expect(
      service.claimDueSchedules({
        cwd,
        sessionId: 'session-fence',
        now: 2_001,
      }),
    ).toHaveLength(1)
    const reclaimed = service.getGoal(started.id)
    expect(reclaimed?.activeRun?.id).not.toBe(oldRunId)

    resolveEvaluation({ action: 'complete', reason: 'Old evaluator result.' })
    const outcome = await evaluation
    expect(outcome.action).toBe('none')
    expect(service.getGoal(started.id)?.status).toBe('running')
    expect(service.getGoal(started.id)?.activeRun?.id).toBe(
      reclaimed?.activeRun?.id,
    )
  })

  test('allows only one active GoalRun per workspace/session', () => {
    const root = makeRoot()
    const clock = new TestClock(1_000)
    const service = makeService(root, clock)
    const first = service.startGoal({
      cwd: join(root, 'workspace'),
      sessionId: 'session-single-active',
      objective: 'First active goal',
    })

    expect(() =>
      service.startGoal({
        cwd: first.cwd,
        sessionId: first.sessionId,
        objective: 'Second active goal',
      }),
    ).toThrow('An active goal already exists for this session')
    expect(
      service
        .listGoals()
        .filter(
          goal =>
            goal.status === 'running' && goal.sessionId === first.sessionId,
        ),
    ).toHaveLength(1)
  })

  test('rejects invalid state transitions instead of silently corrupting state', () => {
    const root = makeRoot()
    const service = makeService(root, new TestClock(1_000))
    const goal = service.createGoal({
      id: 'goal-transitions',
      cwd: join(root, 'workspace'),
      sessionId: 'session-a',
      objective: 'Protect the state machine',
      schedule: { kind: 'once', prompt: 'Do work.', runAt: 2_000 },
    })

    // A fenced call on a goal that left `running` is a stale-run no-op per
    // the runId fencing contract (checked before the transition table); it
    // is not an illegal transition. Unfenced illegal transitions below
    // still throw.
    expect(service.completeGoal(goal.id, { runId: 'not-running' })).toBeNull()

    const running = service.startGoal({
      cwd: join(root, 'workspace-2'),
      sessionId: 'session-terminal',
      objective: 'Keep completion terminal',
    })
    service.completeGoal(running.id, {
      runId: running.activeRun?.id ?? '',
      now: 1_001,
    })
    expect(() => service.cancelGoal(running.id)).toThrow(
      'cannot transition from completed to cancelled',
    )
    expect(() => service.resumeGoal(running.id)).toThrow(
      'cannot transition from completed to scheduled',
    )
  })

  test('treats fenced mutations on a recovered goal as stale no-ops', () => {
    const root = makeRoot()
    const clock = new TestClock(1_000)
    const service = makeService(root, clock)
    const started = service.startGoal({
      cwd: join(root, 'workspace'),
      sessionId: 'session-stale-fence',
      objective: 'Recover then fence',
    })
    const oldRunId = started.activeRun?.id ?? ''
    expect(oldRunId).not.toBe('')

    // Lease (1s) expires; recovery moves the run back to scheduled.
    const recovered = service.recoverInterruptedGoals({
      cwd: started.cwd,
      sessionId: started.sessionId,
      now: 2_001,
    })
    expect(recovered.map(goal => goal.id)).toEqual([started.id])
    expect(service.getGoal(started.id)?.status).toBe('scheduled')

    // The stale run's terminal decisions must no-op, never throw.
    expect(
      service.completeGoal(started.id, { runId: oldRunId, now: 2_001 }),
    ).toBeNull()
    expect(
      service.pauseGoal(started.id, { runId: oldRunId, now: 2_001 }),
    ).toBeNull()
    expect(service.getGoal(started.id)?.status).toBe('scheduled')

    // The recovered retry slot is still claimable by a fresh run.
    expect(
      service.claimDueSchedules({
        cwd: started.cwd,
        sessionId: started.sessionId,
        now: 2_001,
      }),
    ).toHaveLength(1)
    expect(service.getGoal(started.id)?.status).toBe('running')
  })

  test('rejects unsafe execution limits and oversized acceptance input', () => {
    const root = makeRoot()
    const service = makeService(root, new TestClock(1_000))
    const base = {
      cwd: join(root, 'workspace'),
      sessionId: 'session-limits',
      objective: 'Bound unattended execution',
      schedule: { kind: 'once' as const, prompt: 'Do bounded work.' },
    }

    expect(() =>
      service.createGoal({
        ...base,
        loop: { maxIterations: MAX_GOAL_CONTINUATIONS + 1 },
      }),
    ).toThrow(`between 1 and ${MAX_GOAL_CONTINUATIONS}`)
    expect(() =>
      service.createGoal({
        ...base,
        acceptanceCriteria: ['x'.repeat(1_001)],
      }),
    ).toThrow('cannot exceed 1000 characters')
    expect(() =>
      service.createGoal({
        ...base,
        schedule: { kind: 'once', prompt: 'Invalid time.', runAt: -1 },
      }),
    ).toThrow('runAt must be a safe integer')
    expect(() =>
      makeService(root, new TestClock(1.5)).createGoal({
        ...base,
        schedule: { kind: 'once', prompt: 'Fractional clock.' },
      }),
    ).toThrow('timestamp must be a non-negative safe integer')
    expect(service.listGoals()).toHaveLength(0)
  })

  test('caps configured leases and refuses timestamp overflow', () => {
    const root = makeRoot()
    const service = new GoalService({
      rootDir: root,
      clock: new TestClock(1_000),
      leaseDurationMs: Number.MAX_VALUE,
      idFactory: () => 'lease-run',
    })
    const goal = service.startGoal({
      cwd: join(root, 'workspace'),
      sessionId: 'session-lease-cap',
      objective: 'Keep leases representable',
    })
    expect(goal.lease?.expiresAt).toBe(1_000 + 24 * 60 * 60 * 1_000)

    const overflow = new GoalService({
      rootDir: root,
      clock: new TestClock(Number.MAX_SAFE_INTEGER),
      idFactory: () => 'overflow-run',
    })
    expect(() =>
      overflow.startGoal({
        cwd: join(root, 'workspace-2'),
        sessionId: 'session-lease-overflow',
        objective: 'Reject an overflowing lease',
      }),
    ).toThrow('Goal lease exceeds the supported timestamp range')
    expect(overflow.getGoal('overflow-run')?.status).toBe('scheduled')
  })

  test('fails closed when persisted running-state identities are inconsistent', () => {
    const root = makeRoot()
    const service = makeService(root, new TestClock(1_000))
    const goal = service.startGoal({
      cwd: join(root, 'workspace'),
      sessionId: 'session-corrupt',
      objective: 'Do not load a zombie GoalRun',
    })
    const path = service.storage.getGoalFilePath(goal.id)
    const persisted = JSON.parse(readFileSync(path, 'utf8')) as Record<
      string,
      unknown
    >
    delete persisted.lease
    writeFileSync(path, JSON.stringify(persisted), 'utf8')

    expect(service.getGoal(goal.id)).toBeNull()
    expect(
      service.findActiveGoal({ cwd: goal.cwd, sessionId: goal.sessionId }),
    ).toBeNull()
  })

  test('polls recovery, claim, and direct dispatch from one goal snapshot', () => {
    const root = makeRoot()
    const service = makeService(root, new TestClock(1_000))
    for (let index = 0; index < 20; index += 1) {
      service.createGoal({
        id: `background-${index}`,
        cwd: join(root, 'workspace'),
        sessionId: `other-${index}`,
        objective: `Background ${index}`,
        schedule: {
          kind: 'once',
          prompt: `Background ${index}`,
          runAt: 10_000,
        },
      })
    }
    const scans = spyOn(service.storage, 'listGoals')
    const scheduler = new GoalScheduler(service)

    expect(
      scheduler.tick({
        cwd: join(root, 'workspace'),
        sessionId: 'target',
        now: 1_000,
      }),
    ).toEqual([])
    expect(scans).toHaveBeenCalledTimes(1)
  })

  test('edits an idle goal definition with revision fencing and preserves routing identity', () => {
    const root = makeRoot()
    const service = makeService(root, new TestClock(10_000))
    const created = service.createScheduledForControlPlane({
      cwd: join(root, 'workspace'),
      sessionId: 'session-edit',
      objective: 'Initial objective',
      acceptanceCriteria: ['Initial criterion'],
      maxIterations: 4,
      schedule: { kind: 'once', runAt: 20_000 },
    })!

    const updated = service.updateScheduleForControlPlane({
      cwd: created.cwd,
      sessionId: created.sessionId,
      scheduleId: created.schedule.id,
      expectedRevision: created.revision,
      objective: 'Ship the complete goal workflow',
      acceptanceCriteria: ['Focused tests pass', 'Build succeeds'],
      maxIterations: 12,
      schedule: { kind: 'once', runAt: 30_000 },
      now: 10_100,
    })

    expect(updated.ok).toBe(true)
    if (!updated.ok) return
    expect(updated.goal).toMatchObject({
      objective: 'Ship the complete goal workflow',
      acceptanceCriteria: ['Focused tests pass', 'Build succeeds'],
      loop: { maxIterations: 12 },
      status: 'scheduled',
    })
    expect(updated.goal.schedule).toMatchObject({
      id: created.schedule.id,
      goalId: created.id,
      prompt: 'Ship the complete goal workflow',
      runAt: 30_000,
      nextRunAt: 30_000,
    })
    expect(service.storage.listEvents(created.id).at(-1)).toMatchObject({
      type: 'updated',
      revision: updated.goal.revision,
    })

    expect(
      service.updateScheduleForControlPlane({
        cwd: created.cwd,
        sessionId: created.sessionId,
        scheduleId: created.schedule.id,
        expectedRevision: created.revision,
        objective: 'Overwrite a newer edit',
      }),
    ).toEqual({ ok: false, reason: 'revision_conflict' })
  })

  test('refuses live edits, queues run-now without bypassing claim, and retries failed work', () => {
    const root = makeRoot()
    const service = makeService(root, new TestClock(1_000))
    const future = service.createGoal({
      id: 'goal-run-now',
      cwd: join(root, 'workspace'),
      sessionId: 'session-run-now',
      objective: 'Run through the normal scheduler',
      schedule: { kind: 'once', prompt: 'Normal scheduler', runAt: 50_000 },
    })
    const requested = service.transitionScheduleForControlPlane({
      cwd: future.cwd,
      sessionId: future.sessionId,
      scheduleId: future.schedule.id,
      expectedRevision: future.revision,
      action: 'run_now',
      now: 1_100,
    })
    expect(requested.ok).toBe(true)
    if (!requested.ok) return
    expect(requested.goal.status).toBe('scheduled')
    expect(requested.goal.activeRun).toBeUndefined()
    expect(requested.goal.schedule.retryAt).toBe(1_100)

    expect(
      service.claimDueSchedules({
        cwd: future.cwd,
        sessionId: future.sessionId,
        now: 1_100,
      }),
    ).toHaveLength(1)
    const running = service.getGoal(future.id)!
    expect(
      service.updateScheduleForControlPlane({
        cwd: running.cwd,
        sessionId: running.sessionId,
        scheduleId: running.schedule.id,
        expectedRevision: running.revision,
        objective: 'Unsafe live rewrite',
      }),
    ).toEqual({ ok: false, reason: 'active_run' })

    const failed = service.failGoal(running.id, {
      runId: running.activeRun?.id,
      reason: 'Focused test failed.',
      now: 1_200,
    })!
    const retried = service.transitionScheduleForControlPlane({
      cwd: failed.cwd,
      sessionId: failed.sessionId,
      scheduleId: failed.schedule.id,
      expectedRevision: failed.revision,
      action: 'retry',
      now: 1_300,
    })
    expect(retried.ok).toBe(true)
    if (!retried.ok) return
    expect(retried.goal).toMatchObject({ status: 'scheduled' })
    expect(retried.goal.schedule.retryAt).toBe(1_300)
    expect(
      service.storage
        .listEvents(failed.id)
        .slice(-2)
        .map(event => event.type),
    ).toEqual(['failed', 'retried'])
  })

  test('returns only the latest bounded schedule events in chronological order', () => {
    const root = makeRoot()
    const service = makeService(root, new TestClock(1_000))
    let goal = service.createGoal({
      id: 'goal-event-tail',
      cwd: join(root, 'workspace'),
      sessionId: 'session-event-tail',
      objective: 'Keep event reads bounded',
      schedule: { kind: 'once', prompt: 'Read a bounded tail', runAt: 50_000 },
    })
    for (let index = 0; index < 12; index += 1) {
      const result = service.transitionScheduleForControlPlane({
        cwd: goal.cwd,
        sessionId: goal.sessionId,
        scheduleId: goal.schedule.id,
        expectedRevision: goal.revision,
        action: 'run_now',
        reason: `Request ${index}`,
        now: 2_000 + index,
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      goal = result.goal
    }

    const recent = service.listScheduleEventsForControlPlane({
      cwd: goal.cwd,
      sessionId: goal.sessionId,
      scheduleId: goal.schedule.id,
      limit: 3,
    })
    expect(recent?.map(event => event.message)).toEqual([
      'Request 9',
      'Request 10',
      'Request 11',
    ])
  })
})

describe('scope lock recovery', () => {
  // Mirrors GoalStorage.getScopeLockFilePath.
  function scopeLockPath(root: string, cwd: string, sessionId: string): string {
    const key = createHash('sha256')
      .update(`${cwd}\0${sessionId}`)
      .digest('hex')
      .slice(0, 24)
    return join(root, 'goals', `.scope-${key}.lock`)
  }

  function deadPid(): number {
    // A child that has already exited owns a PID that is guaranteed dead
    // (until the OS reuses it, which does not happen within this test).
    const child = spawnSync(process.execPath, ['-e', ''])
    expect(child.status).toBe(0)
    return child.pid
  }

  test('reclaims a scope lock whose owner process is gone without waiting for the mtime timeout', () => {
    const root = makeRoot()
    const clock = new TestClock(1_000)
    const service = makeService(root, clock)
    const cwd = join(root, 'ws')
    const sessionId = 'session-lock'

    const lockPath = scopeLockPath(root, cwd, sessionId)
    mkdirSync(dirname(lockPath), { recursive: true })
    // Dead owner with a FRESH mtime: the old mtime-only path would refuse to
    // reclaim this for 30s; PID liveness reclaims it on the first attempt.
    writeFileSync(lockPath, `${deadPid()} dead-owner 0\n`)

    expect(() =>
      service.pollDueSchedule({ cwd, sessionId, now: 1_000 }),
    ).not.toThrow()
  })

  test('never evicts a scope lock whose owner is still alive even when mtime is old', () => {
    const root = makeRoot()
    const clock = new TestClock(1_000)
    const service = makeService(root, clock)
    const cwd = join(root, 'ws')
    const sessionId = 'session-lock'

    const lockPath = scopeLockPath(root, cwd, sessionId)
    mkdirSync(dirname(lockPath), { recursive: true })
    writeFileSync(lockPath, `${process.pid} live-owner 0\n`)
    const old = new Date(Date.now() - 60_000)
    utimesSync(lockPath, old, old)

    // Evicting a live writer would let two processes mutate the goal store
    // concurrently; the waiter must fail instead of corrupting data.
    expect(() =>
      service.pollDueSchedule({ cwd, sessionId, now: 1_000 }),
    ).toThrow(/Failed to acquire goal store lock/)
  })
})
