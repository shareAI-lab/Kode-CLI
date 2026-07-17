import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GoalService, type Clock } from './index'

class TestClock implements Clock {
  constructor(public value: number) {}
  now(): number {
    return this.value
  }
}

const roots: string[] = []
afterEach(() => {
  while (roots.length) {
    rmSync(roots.pop()!, { recursive: true, force: true })
  }
})

function makeService(now = 1_000) {
  const root = mkdtempSync(join(tmpdir(), 'kode-goal-cp-'))
  roots.push(root)
  const clock = new TestClock(now)
  let nextId = 0
  const service = new GoalService({
    rootDir: root,
    clock,
    idFactory: () => `goal-cp-${++nextId}`,
  })
  return { root, service, clock }
}

describe('goal control plane', () => {
  test('creates scheduled goals and transitions pause/resume/cancel with revision fencing', () => {
    const { service, root } = makeService()
    const cwd = join(root, 'ws')
    const sessionId = 'session-cp'

    const created = service.createScheduledForControlPlane({
      cwd,
      sessionId,
      objective: 'Nightly check',
      schedule: { kind: 'interval', everyMs: 60_000 },
    })
    expect(created?.status).toBe('scheduled')
    expect(created?.schedule.kind).toBe('interval')

    const paused = service.transitionScheduleForControlPlane({
      cwd,
      sessionId,
      scheduleId: created!.schedule.id,
      expectedRevision: created!.revision,
      action: 'pause',
      reason: 'hold',
    })
    expect(paused).toMatchObject({ ok: true })
    if (paused.ok) {
      expect(paused.goal.status).toBe('paused')
      expect(paused.goal.revision).toBe(created!.revision + 1)
    }

    const stale = service.transitionScheduleForControlPlane({
      cwd,
      sessionId,
      scheduleId: created!.schedule.id,
      expectedRevision: created!.revision,
      action: 'resume',
    })
    expect(stale).toEqual({ ok: false, reason: 'revision_conflict' })

    const resumed = service.transitionScheduleForControlPlane({
      cwd,
      sessionId,
      scheduleId: created!.schedule.id,
      expectedRevision: paused.ok ? paused.goal.revision : -1,
      action: 'resume',
    })
    expect(resumed.ok).toBe(true)
    if (resumed.ok) expect(resumed.goal.status).toBe('scheduled')

    const cancelled = service.transitionScheduleForControlPlane({
      cwd,
      sessionId,
      scheduleId: created!.schedule.id,
      expectedRevision: resumed.ok ? resumed.goal.revision : -1,
      action: 'cancel',
    })
    expect(cancelled.ok).toBe(true)
    if (cancelled.ok) expect(cancelled.goal.status).toBe('cancelled')
  })

  test('refuses create when an active goal already exists', () => {
    const { service, root } = makeService()
    const cwd = join(root, 'ws')
    const sessionId = 'session-active'
    service.startGoal({
      cwd,
      sessionId,
      objective: 'Active one',
    })
    const blocked = service.createScheduledForControlPlane({
      cwd,
      sessionId,
      objective: 'Second',
      schedule: { kind: 'once' },
    })
    expect(blocked).toBeNull()
  })

  test('refuses transitions against an active run and defers interval first fire', () => {
    const { service, root, clock } = makeService(5_000)
    const cwd = join(root, 'ws')
    const sessionId = 'session-running'
    const created = service.createScheduledForControlPlane({
      cwd,
      sessionId,
      objective: 'Deferred loop',
      schedule: { kind: 'interval', everyMs: 60_000 },
    })
    expect(created).not.toBeNull()
    expect(created!.schedule.kind).toBe('interval')
    if (created!.schedule.kind === 'interval') {
      expect(created!.schedule.anchorAt).toBe(5_000 + 60_000)
      expect(created!.schedule.nextRunAt).toBe(5_000 + 60_000)
    }

    // Force an active lease/run shape the control plane must refuse.
    service.startGoal({
      cwd: join(root, 'other'),
      sessionId: 'other-session',
      objective: 'Unrelated',
    })
    const active = service.startGoal({
      cwd,
      sessionId: 'session-live',
      objective: 'Live goal',
    })
    const blocked = service.transitionScheduleForControlPlane({
      cwd: active.cwd,
      sessionId: active.sessionId,
      scheduleId: active.schedule.id,
      expectedRevision: active.revision,
      action: 'pause',
      now: clock.value,
    })
    expect(blocked).toEqual({ ok: false, reason: 'active_run' })
  })
})
