import type { ToolUseConfirm } from './PermissionRequest'

/** Risk scores at or above this flip the dialog's default focus to "Deny". */
export const HIGH_RISK_SCORE_THRESHOLD = 70

/**
 * Default focus for permission selects: high-risk requests start focused on
 * the deny option so a stray Enter can never approve an unreviewed dangerous
 * action. Returns undefined (first option = "Allow once") for normal requests.
 */
export function defaultPermissionFocusValue(
  riskScore: number | null,
): string | undefined {
  if (riskScore !== null && riskScore >= HIGH_RISK_SCORE_THRESHOLD) {
    return 'no'
  }
  return undefined
}

function safeInputKey(input: ToolUseConfirm['input']): string {
  try {
    return JSON.stringify(input)
  } catch {
    return 'input'
  }
}

export function permissionSelectFocusScope(
  toolUseConfirm: ToolUseConfirm,
  area: string,
): string {
  const contextId =
    toolUseConfirm.toolUseContext.toolUseId ??
    toolUseConfirm.toolUseContext.messageId ??
    toolUseConfirm.assistantMessage.message.id ??
    safeInputKey(toolUseConfirm.input)
  const toolName = toolUseConfirm.tool?.name ?? 'tool'

  return `permission:${toolName}:${contextId}:${area}`
}
