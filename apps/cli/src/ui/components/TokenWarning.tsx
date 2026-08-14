import { Box, Text } from 'ink'
import * as React from 'react'
import {
  ERROR_MARGIN_TOKENS,
  WARNING_MARGIN_TOKENS,
  calculateAutoCompactThresholds,
  getEffectiveConversationContextLimit,
} from '#core/utils/autoCompactThreshold'
import { getModelManager } from '#core/utils/model'
import { getTheme } from '#core/utils/theme'
import {
  formatTokenCount,
  isRenderableContextLimit,
} from '#ui-ink/utils/tokenDisplay'

type Props = {
  tokenUsage: number
  contextLimit?: number
}

export type TokenWarningState = {
  text: string
  isError: boolean
} | null

/**
 * Pure warning-state computation shared by the component and its tests.
 *
 * Two tiers:
 * - warning: within WARNING_MARGIN_TOKENS of the auto-compact boundary
 * - error:   within ERROR_MARGIN_TOKENS of the boundary (closer to it)
 * The percent and the X/Y fraction share the effective context limit as their
 * denominator, so "N% remaining" always matches "X/Y".
 */
export function computeTokenWarningState(args: {
  tokenUsage: number
  contextLimit: number
}): TokenWarningState {
  const effectiveContextLimit = getEffectiveConversationContextLimit(
    args.contextLimit,
  )
  const { autoCompactThreshold } = calculateAutoCompactThresholds(
    args.tokenUsage,
    effectiveContextLimit,
  )
  const safeThreshold = Math.max(1, Math.floor(autoCompactThreshold))

  const warningThreshold = Math.max(0, safeThreshold - WARNING_MARGIN_TOKENS)
  const errorThreshold = Math.max(0, safeThreshold - ERROR_MARGIN_TOKENS)

  if (args.tokenUsage < warningThreshold) return null

  const isError = args.tokenUsage >= errorThreshold
  const percentRemaining = Math.max(
    0,
    100 - Math.round((args.tokenUsage / effectiveContextLimit) * 100),
  )
  const text =
    `Context low (${percentRemaining}% remaining, ` +
    `${formatTokenCount(args.tokenUsage)}/${formatTokenCount(effectiveContextLimit)}) ` +
    `- Run /compact to compact & continue`

  return { text, isError }
}

function getActiveContextLimit(): number | null {
  try {
    const profile = getModelManager().getModel('main')
    if (isRenderableContextLimit(profile?.contextLength)) {
      return profile.contextLength
    }
  } catch {
    // fall through
  }
  return null
}

export function TokenWarning({
  tokenUsage,
  contextLimit: contextLimitProp,
}: Props): React.ReactNode {
  const theme = getTheme()
  const contextLimit =
    contextLimitProp === undefined
      ? getActiveContextLimit()
      : isRenderableContextLimit(contextLimitProp)
        ? contextLimitProp
        : null
  if (contextLimit === null) return null

  const state = computeTokenWarningState({ tokenUsage, contextLimit })
  if (state === null) return null

  return (
    <Box flexDirection="row">
      <Text
        color={state.isError ? theme.error : theme.warning}
        wrap="truncate-end"
      >
        {state.text}
      </Text>
    </Box>
  )
}
