import { Box, Text } from 'ink'
import * as React from 'react'
import { useMemo } from 'react'
import { wrapLines } from '#ui-ink/primitives/text/wrapLines'
import { getCachedStringWidth } from '#cli-utils/textWidth'

const FIRST_LINE_PREFIX = '  ↳ '
const WRAPPED_LINE_PREFIX = '    '
const MORE_QUEUED_PREFIX = '    … '
const ELLIPSIS_LINE = '    …'
export const QUEUED_PROMPTS_HEADER = 'Queued · Alt+Up edit'
export const QUEUED_PROMPTS_HEADER_SHORT = 'Queued'

export function __getQueuedPromptLinesForTests(args: {
  queuedPrompts: string[]
  width: number
  maxMessages?: number
  maxLinesPerMessage?: number
}): string[] {
  const safeWidth = Math.max(1, args.width)
  const maxMessages = Math.max(1, args.maxMessages ?? 8)
  const maxLinesPerMessage = Math.max(1, args.maxLinesPerMessage ?? 3)
  if (safeWidth < 8) return []
  if (args.queuedPrompts.length === 0) return []

  const hiddenEarlierCount = Math.max(
    0,
    args.queuedPrompts.length - maxMessages,
  )
  const visiblePrompts =
    hiddenEarlierCount > 0
      ? args.queuedPrompts.slice(-maxMessages)
      : args.queuedPrompts

  const prefixWidth = getCachedStringWidth(WRAPPED_LINE_PREFIX)
  const contentWidth = Math.max(1, safeWidth - prefixWidth)

  const lines: string[] = []

  if (hiddenEarlierCount > 0) {
    lines.push(`${MORE_QUEUED_PREFIX}(+${hiddenEarlierCount} earlier)`)
  }

  for (const raw of visiblePrompts) {
    const message = raw.trim()
    if (!message) continue

    const wrapped = wrapLines(message.split('\n'), contentWidth)
    const visible = wrapped.slice(0, maxLinesPerMessage)

    visible.forEach((line, index) => {
      lines.push(
        index === 0
          ? `${FIRST_LINE_PREFIX}${line}`
          : `${WRAPPED_LINE_PREFIX}${line}`,
      )
    })

    if (wrapped.length > maxLinesPerMessage) {
      lines.push(ELLIPSIS_LINE)
    }
  }

  if (lines.length === 0) return []

  lines.unshift(
    safeWidth >= 28 ? QUEUED_PROMPTS_HEADER : QUEUED_PROMPTS_HEADER_SHORT,
  )
  return lines
}

export function QueuedPrompts({
  queuedPrompts,
  width,
}: {
  queuedPrompts: string[]
  width: number
}): React.ReactNode {
  const lines = useMemo(
    () => __getQueuedPromptLinesForTests({ queuedPrompts, width }),
    [queuedPrompts, width],
  )

  if (lines.length === 0) return null

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={index} dimColor italic wrap="truncate-end">
          {line}
        </Text>
      ))}
    </Box>
  )
}
