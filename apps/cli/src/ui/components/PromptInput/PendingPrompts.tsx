import { Box, Text } from 'ink'
import * as React from 'react'
import { useMemo } from 'react'
import { wrapLines } from '#ui-ink/primitives/text/wrapLines'
import { getCachedStringWidth } from '#cli-utils/textWidth'

const FIRST_LINE_PREFIX = '  › '
const WRAPPED_LINE_PREFIX = '    '
const MORE_PENDING_PREFIX = '    … '
const ELLIPSIS_LINE = '    …'
export const PENDING_PROMPTS_HEADER = 'Next · sends after this turn'
export const PENDING_PROMPTS_HEADER_SHORT = 'Next'

export function __getPendingPromptLinesForTests(args: {
  pendingPrompts: string[]
  width: number
  maxMessages?: number
  maxLinesPerMessage?: number
}): string[] {
  const safeWidth = Math.max(1, args.width)
  const maxMessages = Math.max(1, args.maxMessages ?? 6)
  const maxLinesPerMessage = Math.max(1, args.maxLinesPerMessage ?? 3)
  if (safeWidth < 8) return []
  if (args.pendingPrompts.length === 0) return []

  const hiddenEarlierCount = Math.max(
    0,
    args.pendingPrompts.length - maxMessages,
  )
  const visiblePrompts =
    hiddenEarlierCount > 0
      ? args.pendingPrompts.slice(-maxMessages)
      : args.pendingPrompts

  const prefixWidth = getCachedStringWidth(WRAPPED_LINE_PREFIX)
  const contentWidth = Math.max(1, safeWidth - prefixWidth)

  const lines: string[] = []

  if (hiddenEarlierCount > 0) {
    lines.push(`${MORE_PENDING_PREFIX}(+${hiddenEarlierCount} earlier)`)
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
    safeWidth >= 36 ? PENDING_PROMPTS_HEADER : PENDING_PROMPTS_HEADER_SHORT,
  )
  return lines
}

export function PendingPrompts({
  pendingPrompts,
  width,
}: {
  pendingPrompts: string[]
  width: number
}): React.ReactNode {
  const lines = useMemo(
    () => __getPendingPromptLinesForTests({ pendingPrompts, width }),
    [pendingPrompts, width],
  )

  if (lines.length === 0) return null

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={index} wrap="truncate-end">
          {line}
        </Text>
      ))}
    </Box>
  )
}
