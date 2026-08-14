import { Box, Text } from 'ink'
import React, { useMemo } from 'react'
import { getTheme } from '#core/utils/theme'
import type { Goal } from '#core/goals'

function truncate(text: string, maxWidth: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxWidth) return normalized
  if (maxWidth <= 1) return normalized.slice(0, Math.max(0, maxWidth))
  return `${normalized.slice(0, maxWidth - 1)}…`
}

function formatCountdown(
  targetAt: number | null | undefined,
  now: number,
): string {
  if (targetAt === null || targetAt === undefined) return ''
  const seconds = Math.max(0, Math.ceil((targetAt - now) / 1000))
  if (seconds <= 0) return 'now'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

function statusLabel(goal: Goal): string {
  switch (goal.status) {
    case 'scheduled':
      return 'scheduled'
    case 'running':
      return 'running'
    case 'awaiting_approval':
      return 'awaiting approval'
    case 'paused':
      return 'paused'
    case 'completed':
      return 'completed'
    default:
      return goal.status
  }
}

export function buildGoalStatusLineForTests(args: {
  goal: Goal
  now: number
  maxWidth: number
}): { line: string; label: string } | null {
  const { goal, now, maxWidth } = args
  if (goal.status !== 'scheduled' && goal.status !== 'running') return null

  const progress =
    goal.schedule.kind === 'interval'
      ? `轮 ${goal.activeRun?.turnCount ?? 0}/${goal.loop.maxIterations}`
      : goal.schedule.kind === 'once'
        ? `轮 ${goal.activeRun?.turnCount ?? 0}`
        : ''
  const countdown = formatCountdown(
    goal.schedule.kind === 'interval' ? goal.schedule.nextRunAt : null,
    now,
  )
  const parts = [
    statusLabel(goal),
    progress,
    countdown ? `下轮 ${countdown}` : '',
  ].filter(Boolean)
  const suffix = parts.length > 0 ? ` · ${parts.join(' · ')}` : ''
  const line = `${truncate(goal.objective, Math.max(10, maxWidth - suffix.length))}${suffix}`
  return {
    line: line.length <= maxWidth ? line : truncate(line, maxWidth),
    label: statusLabel(goal),
  }
}

export function GoalStatusPanel({
  maxWidth,
  goal,
  now = Date.now(),
}: {
  maxWidth: number
  goal: Goal | null
  now?: number
}): React.ReactNode {
  const theme = getTheme()
  const line = useMemo(
    () => (goal ? buildGoalStatusLineForTests({ goal, now, maxWidth }) : null),
    [goal, now, maxWidth],
  )
  if (!line) return null

  const isRunning = goal!.status === 'running'
  const glyph = isRunning ? '■' : '⏱'
  const color =
    goal!.status === 'awaiting_approval' ? theme.warning : theme.kode

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.secondaryBorder}
      paddingX={1}
      width="100%"
    >
      <Box justifyContent="space-between" width="100%">
        <Text color={theme.secondaryText}>Goal</Text>
        <Text color={theme.secondaryText}>/goal</Text>
      </Box>
      <Box flexDirection="row" width="100%">
        <Text color={color}>{glyph} </Text>
        <Text color={theme.text} wrap="truncate-end">
          {line.line}
        </Text>
      </Box>
    </Box>
  )
}
