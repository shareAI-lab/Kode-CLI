import React from 'react'
import { Box, Text } from 'ink'
import { usePermissionContext } from '#ui-ink/contexts/PermissionContext'
import { getTheme, type Theme } from '#core/utils/theme'
import { getPermissionModeCycleShortcut } from '#ui-ink/utils/permissionModeCycleShortcut'
import type { PermissionMode } from '#core/types/PermissionMode'
import { normalizePermissionMode } from '#core/types/PermissionMode'
import {
  getPermissionModeDetail,
  getPermissionModeStatusLabel,
} from '#ui-ink/utils/permissionModeDisplay'

interface ModeIndicatorProps {
  showTransitionCount?: boolean
}

export function ModeIndicator({
  showTransitionCount = false,
}: ModeIndicatorProps) {
  const { currentMode, permissionContext } = usePermissionContext()
  const theme = getTheme()
  const shortcut = getPermissionModeCycleShortcut()

  const normalized = normalizePermissionMode(currentMode)

  const indicator = __getModeIndicatorDisplayForTests({
    mode: normalized,
    shortcutDisplayText: shortcut.displayText,
    theme,
  })

  if (!indicator.shouldRender && !showTransitionCount) {
    return null
  }

  return (
    <Box flexDirection="row" justifyContent="space-between" width="100%">
      <Text color={indicator.color} wrap="truncate-end">
        {indicator.mainText}
        {indicator.shortcutHintText ? (
          <Text color={theme.secondaryText}>{indicator.shortcutHintText}</Text>
        ) : null}
      </Text>
      {showTransitionCount && (
        <Text color={theme.secondaryText} wrap="truncate-end">
          Switches: {permissionContext.metadata.transitionCount}
        </Text>
      )}
    </Box>
  )
}

export function __getModeIndicatorDisplayForTests(args: {
  mode: PermissionMode
  shortcutDisplayText: string
  theme: Theme
}): {
  shouldRender: boolean
  color: string
  mainText: string
  shortcutHintText: string
} {
  const normalized = normalizePermissionMode(args.mode)

  const color = getModeIndicatorColor(args.theme, normalized)
  const label = getPermissionModeStatusLabel(normalized)
  const detail = getPermissionModeDetail(normalized)

  return {
    shouldRender: true,
    color,
    mainText: `Tool permissions: ${label}`,
    shortcutHintText: ` (${args.shortcutDisplayText} to change · ${detail})`,
  }
}

function getModeIndicatorColor(theme: Theme, mode: PermissionMode): string {
  switch (normalizePermissionMode(mode)) {
    case 'yolo':
      return theme.secondaryText
    case 'cautious':
      return theme.warning
    case 'plan':
      return theme.success
    case 'acceptEdits':
      return theme.autoAccept
    case 'bypassPermissions':
    case 'dontAsk':
      return theme.error
    default:
      return theme.secondaryText
  }
}

// Compact mode indicator for status bar
export function CompactModeIndicator() {
  const { currentMode } = usePermissionContext()
  const theme = getTheme()
  const shortcut = getPermissionModeCycleShortcut()

  const normalized = normalizePermissionMode(currentMode)

  const indicator = __getModeIndicatorDisplayForTests({
    mode: normalized,
    shortcutDisplayText: shortcut.displayText,
    theme,
  })

  return (
    <Text color={indicator.color} wrap="truncate-end">
      {indicator.mainText}
      <Text color={theme.secondaryText}>{indicator.shortcutHintText}</Text>
    </Text>
  )
}
