import { Box, Text } from 'ink'
import React, { useMemo } from 'react'
import { getTheme } from '#core/utils/theme'
import type {
  BackgroundTaskSnapshot,
  BackgroundTaskStatus,
} from '#core/tasks/backgroundRegistry'

const MAX_VISIBLE_TASKS = 3

type RunningTaskRow = {
  key: string
  status: BackgroundTaskStatus
  label: string
  elapsed: string
}

function truncate(text: string, maxWidth: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxWidth) return normalized
  if (maxWidth <= 1) return normalized.slice(0, Math.max(0, maxWidth))
  return `${normalized.slice(0, maxWidth - 1)}…`
}

function formatElapsed(startedAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes <= 0) return `${remainingSeconds}s`
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function isActiveTask(task: BackgroundTaskSnapshot): boolean {
  return task.status === 'running' || task.status === 'pending'
}

function statusGlyph(status: BackgroundTaskStatus): string {
  switch (status) {
    case 'running':
      return '■'
    case 'pending':
      return '□'
    default:
      return '·'
  }
}

export function buildRunningTaskRowsForTests(args: {
  tasks: BackgroundTaskSnapshot[]
  now?: number
  maxWidth: number
}): {
  rows: RunningTaskRow[]
  hiddenCount: number
} {
  const active = args.tasks
    .filter(isActiveTask)
    .slice()
    .sort((a, b) => a.startedAt - b.startedAt)

  const labelWidth = Math.max(12, args.maxWidth - 26)
  const rows = active.slice(0, MAX_VISIBLE_TASKS).map(task => {
    const prefix = task.taskType === 'local_agent' ? 'Agent' : 'Shell'
    const detail =
      task.taskType === 'local_agent'
        ? task.subagentType
          ? `${task.subagentType}: ${task.description}`
          : task.description
        : task.command

    return {
      key: task.taskId,
      status: task.status,
      label: truncate(`${prefix} ${detail}`, labelWidth),
      elapsed: formatElapsed(task.startedAt, args.now),
    }
  })

  return {
    rows,
    hiddenCount: Math.max(0, active.length - rows.length),
  }
}

export function buildRunningTasksLayoutSignature(
  tasks: BackgroundTaskSnapshot[],
): string {
  const activeCount = tasks.filter(isActiveTask).length
  return `${Math.min(activeCount, MAX_VISIBLE_TASKS)}:${
    activeCount > MAX_VISIBLE_TASKS ? 1 : 0
  }`
}

export const RunningTasksPanel = React.memo(function RunningTasksPanel({
  maxWidth,
  tasks,
}: {
  maxWidth: number
  tasks: BackgroundTaskSnapshot[]
}): React.ReactNode {
  const theme = getTheme()
  const { rows, hiddenCount } = useMemo(
    () => buildRunningTaskRowsForTests({ tasks, maxWidth }),
    [maxWidth, tasks],
  )

  if (rows.length === 0) return null

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.secondaryBorder}
      paddingX={1}
      width="100%"
    >
      <Box justifyContent="space-between" width="100%">
        <Text color={theme.secondaryText}>Local Tasks</Text>
        <Text color={theme.secondaryText}>/tasks</Text>
      </Box>
      {rows.map(row => (
        <Box key={row.key} flexDirection="row" width="100%">
          <Text color={row.status === 'running' ? theme.warning : theme.text}>
            {statusGlyph(row.status)}{' '}
          </Text>
          <Text color={theme.text} wrap="truncate-end">
            {row.label}
          </Text>
          <Text color={theme.secondaryText}> · {row.elapsed}</Text>
        </Box>
      ))}
      {hiddenCount > 0 && (
        <Text color={theme.secondaryText} wrap="truncate-end">
          +{hiddenCount} more in /tasks
        </Text>
      )}
    </Box>
  )
})
