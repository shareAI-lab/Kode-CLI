import { Box, Text } from 'ink'
import React, { useSyncExternalStore } from 'react'
import { MaxSizedText } from '#ui-ink/components/MaxSizedText'
import { useTerminalSize } from '#ui-ink/hooks/useTerminalSize'
import { CIRCLE } from '#core/constants/figures'
import { getTheme } from '#core/utils/theme'
import type { TranscriptItem } from './useTranscriptItems'
import type { AssistantStreamStore } from './assistantStreamStore'

export const ASSISTANT_STREAM_PREVIEW_CHARS_PER_CELL = 4
const MIN_ASSISTANT_STREAM_PREVIEW_CHARS = 512

export function getLivePreviewHeightBudget(args: {
  hasThinking: boolean
  hasText: boolean
  maxHeight: number
}): { thinking: number; text: number } {
  if (!args.hasThinking && !args.hasText) {
    return { thinking: 0, text: 0 }
  }
  if (args.maxHeight <= 1) {
    return args.hasText ? { thinking: 0, text: 1 } : { thinking: 1, text: 0 }
  }
  if (!args.hasThinking) return { thinking: 0, text: args.maxHeight }
  if (!args.hasText) return { thinking: args.maxHeight, text: 0 }

  const thinking = Math.min(4, Math.max(1, Math.floor(args.maxHeight / 3)))
  return { thinking, text: Math.max(1, args.maxHeight - thinking) }
}

export function getBoundedAssistantStreamPreviewText(args: {
  text: string
  maxWidth: number
  maxHeight: number
}): string {
  const maxChars = Math.max(
    MIN_ASSISTANT_STREAM_PREVIEW_CHARS,
    Math.max(1, args.maxWidth) *
      Math.max(1, args.maxHeight) *
      ASSISTANT_STREAM_PREVIEW_CHARS_PER_CELL,
  )
  if (args.text.length <= maxChars) return args.text

  let start = args.text.length - maxChars
  const codeUnit = args.text.charCodeAt(start)
  if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) start += 1
  return `…${args.text.slice(start)}`
}

export function AssistantStreamPreview({
  store,
  transientItems,
  maxHeight,
  isVisible,
  isActive,
  debug,
}: {
  store: AssistantStreamStore
  transientItems: TranscriptItem[]
  maxHeight: number
  isVisible: boolean
  isActive: boolean
  debug: boolean
}) {
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  )
  const hasLiveThinking = snapshot.thinking.trim().length > 0
  const hasLiveText = snapshot.text.trim().length > 0
  const heightBudget = getLivePreviewHeightBudget({
    hasThinking: hasLiveThinking,
    hasText: hasLiveText,
    maxHeight,
  })

  if (
    !isVisible ||
    maxHeight <= 0 ||
    (!isActive &&
      transientItems.length === 0 &&
      !hasLiveThinking &&
      !hasLiveText)
  ) {
    return null
  }

  // The live stream gets its own reserved height at the bottom of the frame so
  // completed transient messages (which can be arbitrarily tall) can never
  // push streaming output out of the viewport.
  const liveHeight = heightBudget.thinking + heightBudget.text
  const completedHeight = Math.max(0, maxHeight - liveHeight)

  return (
    <Box
      flexDirection="column"
      height={maxHeight}
      justifyContent="flex-end"
      overflow="hidden"
      width="100%"
    >
      {transientItems.length > 0 && completedHeight > 0 && (
        <Box
          flexDirection="column"
          height={completedHeight}
          justifyContent="flex-end"
          overflow="hidden"
          width="100%"
        >
          {transientItems.map(item => item.jsx)}
        </Box>
      )}
      {hasLiveThinking && heightBudget.thinking > 0 && (
        <AssistantStreamThinking
          text={snapshot.thinking}
          maxHeight={heightBudget.thinking}
        />
      )}
      {hasLiveText && heightBudget.text > 0 && (
        <AssistantStreamText
          text={snapshot.text}
          addMargin={transientItems.length > 0}
          maxHeight={heightBudget.text}
        />
      )}
    </Box>
  )
}

/**
 * A stream is updated in-place many times before it becomes a completed
 * transcript message. Parsing the whole accumulated value as Markdown for
 * every frame causes incomplete syntax (especially code fences and emphasis)
 * to restyle earlier rows, which makes terminals visibly redraw/flicker.
 *
 * Keep the preview deliberately plain and bounded. The completed message is
 * still rendered by AssistantTextMessage, so finalized transcript output
 * keeps the normal Markdown rendering.
 */
const AssistantStreamText = React.memo(function AssistantStreamText({
  text,
  addMargin,
  maxHeight,
}: {
  text: string
  addMargin: boolean
  maxHeight: number
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const contentWidth = Math.max(1, columns - 6)
  const previewText = getBoundedAssistantStreamPreviewText({
    text,
    maxWidth: contentWidth,
    maxHeight,
  })

  return (
    <Box
      alignItems="flex-start"
      flexDirection="row"
      justifyContent="space-between"
      marginTop={addMargin ? 1 : 0}
      width="100%"
    >
      <Box flexDirection="row">
        <Box minWidth={2}>
          <Text color={getTheme().kode}>{CIRCLE}</Text>
        </Box>
        <Box flexDirection="column" width={contentWidth}>
          <MaxSizedText
            text={previewText}
            maxHeight={maxHeight}
            maxWidth={contentWidth}
            overflowDirection="bottom"
          />
        </Box>
      </Box>
      {/* No cost row here: the live stream store has no real usage/cost data,
          and a hardcoded $0.0000 would mislead debug-mode users. The completed
          message renders the real cost. */}
    </Box>
  )
})

const AssistantStreamThinking = React.memo(function AssistantStreamThinking({
  text,
  maxHeight,
}: {
  text: string
  maxHeight: number
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const contentWidth = Math.max(1, columns - 6)
  const previewText = getBoundedAssistantStreamPreviewText({
    text,
    maxWidth: contentWidth,
    maxHeight,
  })

  if (maxHeight <= 1) {
    return (
      <Box flexDirection="row" width="100%">
        <Box minWidth={2}>
          <Text color={getTheme().kode}>{CIRCLE}</Text>
        </Box>
        <Text color={getTheme().secondaryText} dimColor wrap="truncate-end">
          Thinking: {previewText}
        </Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="row" width="100%">
      <Box minWidth={2}>
        <Text color={getTheme().kode}>{CIRCLE}</Text>
      </Box>
      <Box flexDirection="column" width={contentWidth}>
        <Text color={getTheme().secondaryText} dimColor>
          Thinking
        </Text>
        <MaxSizedText
          text={previewText}
          maxHeight={maxHeight - 1}
          maxWidth={contentWidth}
          overflowDirection="bottom"
        />
      </Box>
    </Box>
  )
})
