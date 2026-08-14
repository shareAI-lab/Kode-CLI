import { afterEach, expect, test } from 'bun:test'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GoalService } from '#core/goals'
import { GoalStorage } from './storage'

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'kode-goal-cache-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

test('listGoals cache reflects mutations and cross-instance writes', () => {
  const rootDir = tempRoot()
  const svc = new GoalService({ rootDir })
  const goal = svc.createGoal({
    cwd: '/tmp',
    sessionId: 's1',
    objective: 'cache test',
    schedule: {
      kind: 'once',
      runAt: Date.now() + 100000,
      prompt: 'run the cache test',
    },
  })

  expect(svc.storage.listGoals().length).toBe(1)

  const other = new GoalService({ rootDir })
  other.storage.mutateGoal(goal.id, current => ({
    goal: { ...current, status: 'completed' },
    result: undefined,
  }))

  const after = svc.storage.listGoals()
  expect(after.length).toBe(1)
  expect(after[0]!.status).toBe('completed')
})

test('reuses an empty goal list cache when the directory is unchanged', () => {
  const rootDir = tempRoot()
  const storage = new GoalStorage({ rootDir })
  const goalsDir = storage.getGoalsDir()
  mkdirSync(goalsDir, { recursive: true })

  expect(storage.listGoals()).toEqual([])

  // Model an external filesystem failure after the first snapshot while
  // retaining the cache's observed mtime. A cached empty list must be just as
  // reusable as a non-empty one and avoid a second directory scan.
  rmSync(goalsDir, { recursive: true, force: true })
  writeFileSync(goalsDir, '')
  const internal = storage as unknown as {
    listCache: { dirMtimeMs: number; goals: unknown[] } | null
  }
  internal.listCache!.dirMtimeMs = statSync(goalsDir).mtimeMs

  expect(storage.listGoals()).toEqual([])
})
