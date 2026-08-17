import { useSyncExternalStore } from 'react'
import {
  listBackgroundTaskSnapshots,
  type BackgroundTaskSnapshot,
} from '#core/tasks/backgroundRegistry'

const TASK_SNAPSHOT_REFRESH_MS = 1000

let snapshotCache: BackgroundTaskSnapshot[] = []
let snapshotSignature = ''
const listeners = new Set<() => void>()
let interval: ReturnType<typeof setInterval> | null = null

function isVisibleBackgroundTask(task: BackgroundTaskSnapshot): boolean {
  return task.status === 'running' || task.status === 'pending'
}

function buildSnapshotSignature(
  tasks: BackgroundTaskSnapshot[],
  now = Date.now(),
): string {
  const runningTick = Math.floor(now / TASK_SNAPSHOT_REFRESH_MS)
  return tasks
    .filter(isVisibleBackgroundTask)
    .map(task =>
      [
        task.taskId,
        task.taskType,
        task.status,
        task.startedAt,
        task.description,
        task.taskType === 'local_bash'
          ? task.command
          : (task.subagentType ?? ''),
        runningTick,
      ].join(':'),
    )
    .join('|')
}

function refreshSnapshot(): void {
  const next = listBackgroundTaskSnapshots()
  const signature = buildSnapshotSignature(next)
  if (signature === snapshotSignature) return

  snapshotSignature = signature
  snapshotCache = next
  listeners.forEach(listener => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  refreshSnapshot()

  if (!interval) {
    interval = setInterval(refreshSnapshot, TASK_SNAPSHOT_REFRESH_MS)
    interval.unref?.()
  }

  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && interval) {
      clearInterval(interval)
      interval = null
    }
  }
}

function getSnapshot(): BackgroundTaskSnapshot[] {
  return snapshotCache
}

export function useBackgroundTaskSnapshots(): BackgroundTaskSnapshot[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export const __backgroundTaskSnapshotStoreForTests = {
  buildSnapshotSignature,
  refreshSnapshot,
  getSnapshot,
}
