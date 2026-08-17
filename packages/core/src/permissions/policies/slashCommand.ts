import { PRODUCT_NAME } from '#core/constants/product'
import type { Tool, ToolUseContext } from '#core/tooling/Tool'
import type { ToolPermissionContext } from '#core/types/toolPermissionContext'

import { getPermissionKey } from '../permissionKey'
import type { PermissionResult } from '../types'
import { getStringFromInput } from './input'

export function checkSlashCommandPermission(args: {
  tool: Tool
  input: Record<string, unknown>
  context: ToolUseContext
  assistantMessage: unknown
  effectiveAllowedTools: string[]
  effectiveDeniedTools: string[]
  effectiveAskedTools: string[]
  effectiveToolPermissionContext: ToolPermissionContext
}): PermissionResult {
  const command = getStringFromInput(args.input, 'command').trim()
  const exactKey = getPermissionKey(args.tool, { command }, null)

  if (args.effectiveDeniedTools.includes(exactKey)) {
    return {
      result: false,
      message: `Permission to use ${args.tool.name}(${command}) has been denied.`,
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

  const firstWord = command.split(/\s+/)[0]
  if (firstWord && firstWord.startsWith('/')) {
    const prefixKey = getPermissionKey(args.tool, { command }, firstWord)
    if (args.effectiveDeniedTools.includes(prefixKey)) {
      return {
        result: false,
        message: `Permission to use ${args.tool.name}(${firstWord}:*) has been denied.`,
        shouldPromptUser: false,
        decisionReason: prefixKey,
      }
    }
    if (args.effectiveAskedTools.includes(prefixKey)) {
      return {
        result: false,
        message: `${PRODUCT_NAME} requested permissions to use ${args.tool.name}, but you haven't granted it yet.`,
        decisionReason: prefixKey,
      }
    }
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
