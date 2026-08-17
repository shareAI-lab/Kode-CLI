import React, { useMemo } from 'react'
import { Box, Text } from 'ink'

import type { ToolUseConfirm } from './PermissionRequest'

function formatAgentLabel(agentId: string): string {
  if (agentId === 'main') return 'Agent: main'
  return `Agent: ${agentId}`
}

function formatModeLabel(mode: unknown): string | null {
  if (mode !== 'plan' && mode !== 'acceptEdits' && mode !== 'cautious') {
    return null
  }
  return `Mode: ${mode}`
}

export function __buildPermissionRequestDetailsLinesForTests(
  toolUseConfirm: ToolUseConfirm,
): string[] {
  const agentId =
    typeof toolUseConfirm.toolUseContext.agentId === 'string'
      ? toolUseConfirm.toolUseContext.agentId.trim()
      : ''

  const mode =
    toolUseConfirm.toolUseContext.options?.toolPermissionContext?.mode
  const modeLabel = formatModeLabel(mode)

  const headerParts: string[] = []
  if (agentId) headerParts.push(formatAgentLabel(agentId))
  if (modeLabel) headerParts.push(modeLabel)
  const header = headerParts.length > 0 ? headerParts.join(' · ') : null

  const blockedPath =
    typeof toolUseConfirm.blockedPath === 'string'
      ? toolUseConfirm.blockedPath.trim()
      : ''
  const decisionReason =
    typeof toolUseConfirm.decisionReason === 'string'
      ? toolUseConfirm.decisionReason.trim()
      : ''

  const lines: string[] = []
  if (header) lines.push(header)
  if (decisionReason) lines.push(`Reason: ${decisionReason}`)
  if (blockedPath) lines.push(`Path: ${blockedPath}`)
  return lines
}

export function PermissionRequestDetails({
  toolUseConfirm,
}: {
  toolUseConfirm: ToolUseConfirm
}): React.ReactNode {
  const lines = useMemo(
    () => __buildPermissionRequestDetailsLinesForTests(toolUseConfirm),
    [toolUseConfirm],
  )
  if (lines.length === 0) return null

  return (
    <Box flexDirection="column">
      {lines.map((line, idx) => (
        <Text key={idx} dimColor wrap="truncate-end">
          {line}
        </Text>
      ))}
    </Box>
  )
}
