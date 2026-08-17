import { PRODUCT_NAME } from '#core/constants/product'
import type { Tool, ToolUseContext } from '#core/tooling/Tool'
import type { ToolPermissionContext } from '#core/types/toolPermissionContext'
import { parseMcpToolName } from '#core/utils/permissions/ruleString'

import { getPermissionKey } from '../permissionKey'
import type { PermissionResult } from '../types'

export function checkDefaultToolPermission(args: {
  tool: Tool
  input: Record<string, unknown>
  context: ToolUseContext
  assistantMessage: unknown
  effectiveAllowedTools: string[]
  effectiveDeniedTools: string[]
  effectiveAskedTools: string[]
  effectiveToolPermissionContext: ToolPermissionContext
}): PermissionResult {
  const permissionKey = getPermissionKey(args.tool, args.input, null)
  const matchesToolRule = (rule: string): boolean => {
    if (rule === permissionKey) return true

    const parsedTool = parseMcpToolName(permissionKey)
    if (!parsedTool) return false

    const parsedRule = parseMcpToolName(rule)
    if (!parsedRule) return false

    return (
      parsedRule.serverName === parsedTool.serverName &&
      parsedRule.toolName === '*'
    )
  }

  const deniedRule = args.effectiveDeniedTools.find(matchesToolRule)
  if (deniedRule) {
    return {
      result: false,
      message: `Permission to use ${args.tool.name} has been denied.`,
      shouldPromptUser: false,
      decisionReason: deniedRule,
    }
  }
  const askedRule = args.effectiveAskedTools.find(matchesToolRule)
  if (askedRule) {
    return {
      result: false,
      message: `${PRODUCT_NAME} requested permissions to use ${args.tool.name}, but you haven't granted it yet.`,
      decisionReason: askedRule,
    }
  }
  if (args.effectiveAllowedTools.some(matchesToolRule)) {
    return { result: true }
  }

  return {
    result: false,
    message: `${PRODUCT_NAME} requested permissions to use ${args.tool.name}, but you haven't granted it yet.`,
    decisionReason: 'No allow rule matched',
  }
}
