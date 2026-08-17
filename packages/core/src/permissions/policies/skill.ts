import { PRODUCT_NAME } from '#core/constants/product'
import type { Tool, ToolUseContext } from '#core/tooling/Tool'
import type { ToolPermissionContext } from '#core/types/toolPermissionContext'

import { getPermissionKey } from '../permissionKey'
import type { PermissionResult } from '../types'
import { getStringFromInput } from './input'

function getSkillPrefixes(skillName: string): string[] {
  const parts = skillName
    .split(':')
    .map(p => p.trim())
    .filter(Boolean)
  if (parts.length <= 1) return []
  return parts.slice(0, -1).map((_, idx) => parts.slice(0, idx + 1).join(':'))
}

export function checkSkillPermission(args: {
  tool: Tool
  input: Record<string, unknown>
  context: ToolUseContext
  assistantMessage: unknown
  effectiveAllowedTools: string[]
  effectiveDeniedTools: string[]
  effectiveAskedTools: string[]
  effectiveToolPermissionContext: ToolPermissionContext
}): PermissionResult {
  const rawSkill = getStringFromInput(args.input, 'skill')
  const skillName = rawSkill.trim().replace(/^\//, '')
  const exactKey = getPermissionKey(args.tool, { skill: skillName }, null)

  if (args.effectiveDeniedTools.includes(exactKey)) {
    return {
      result: false,
      message: `Permission to use ${args.tool.name}(${skillName}) has been denied.`,
      shouldPromptUser: false,
      decisionReason: exactKey,
    }
  }
  if (args.effectiveAskedTools.includes(exactKey)) {
    return {
      result: false,
      message: `${PRODUCT_NAME} requested permissions to use ${args.tool.name}, but you haven't granted it yet.`,
      decisionReason: exactKey,
    }
  }
  if (args.effectiveAllowedTools.includes(exactKey)) {
    return { result: true }
  }

  const prefixes = getSkillPrefixes(skillName)
  for (const prefix of prefixes) {
    const prefixKey = getPermissionKey(args.tool, { skill: skillName }, prefix)
    if (args.effectiveDeniedTools.includes(prefixKey)) {
      return {
        result: false,
        message: `Permission to use ${args.tool.name}(${prefix}:*) has been denied.`,
        shouldPromptUser: false,
        decisionReason: prefixKey,
      }
    }
  }

  for (const prefix of prefixes) {
    const prefixKey = getPermissionKey(args.tool, { skill: skillName }, prefix)
    if (args.effectiveAskedTools.includes(prefixKey)) {
      return {
        result: false,
        message: `${PRODUCT_NAME} requested permissions to use ${args.tool.name}, but you haven't granted it yet.`,
        decisionReason: prefixKey,
      }
    }
  }

  for (const prefix of prefixes) {
    const prefixKey = getPermissionKey(args.tool, { skill: skillName }, prefix)
    if (args.effectiveAllowedTools.includes(prefixKey)) {
      return { result: true }
    }
  }

  return {
    result: false,
    message: `${PRODUCT_NAME} requested permissions to use ${args.tool.name}, but you haven't granted it yet.`,
    decisionReason: 'No allow rule matched',
  }
}
