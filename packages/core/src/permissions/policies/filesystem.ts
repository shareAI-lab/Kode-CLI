import { getCwd } from '#core/utils/state'
import { PRODUCT_NAME } from '#core/constants/product'
import type { Tool, ToolUseContext } from '#core/tooling/Tool'
import type { ToolPermissionContext } from '#core/types/toolPermissionContext'
import {
  expandSymlinkPaths,
  getSpecialAllowedReadReason,
  hasSuspiciousWindowsPathPattern,
  isPathInWorkingDirectories,
  matchPermissionRuleForPath,
  suggestFilePermissionUpdates,
} from '#core/utils/permissions/fileToolPermissionEngine'

import type { PermissionResult } from '../types'
import { getStringFromInput } from './input'

export function checkFilesystemPermission(args: {
  tool: Tool
  input: Record<string, unknown>
  context: ToolUseContext
  assistantMessage: unknown
  effectiveAllowedTools: string[]
  effectiveDeniedTools: string[]
  effectiveAskedTools: string[]
  effectiveToolPermissionContext: ToolPermissionContext
  checkEditPermissionForPath: (toolPath: string) => PermissionResult
}): PermissionResult {
  if (args.tool.name === 'Edit' || args.tool.name === 'Write') {
    const filePath = getStringFromInput(args.input, 'file_path')
    const toolPath = filePath || getCwd()
    return args.checkEditPermissionForPath(toolPath)
  }

  if (args.tool.name === 'NotebookEdit') {
    const notebookPath = getStringFromInput(args.input, 'notebook_path')
    const toolPath = notebookPath || getCwd()
    return args.checkEditPermissionForPath(toolPath)
  }

  const rawPath =
    args.tool.name === 'Read'
      ? getStringFromInput(args.input, 'file_path')
      : getStringFromInput(args.input, 'path')
  const toolPath = rawPath || getCwd()

  const candidates = expandSymlinkPaths(toolPath)
  for (const candidate of candidates) {
    if (candidate.startsWith('\\\\') || candidate.startsWith('//')) {
      return {
        result: false,
        message: `${PRODUCT_NAME} requested permissions to read from ${toolPath}, which appears to be a UNC path that could access network resources.`,
        blockedPath: toolPath,
        decisionReason: 'UNC/network path requires manual approval',
        requiresExplicitApproval: true,
      }
    }
  }
  for (const candidate of candidates) {
    if (hasSuspiciousWindowsPathPattern(candidate)) {
      return {
        result: false,
        message: `${PRODUCT_NAME} requested permissions to read from ${toolPath}, which contains a suspicious Windows path pattern that requires manual approval.`,
        blockedPath: toolPath,
        decisionReason:
          'Suspicious Windows path pattern requires manual approval',
        requiresExplicitApproval: true,
      }
    }
  }

  for (const candidate of candidates) {
    const deniedRule = matchPermissionRuleForPath({
      inputPath: candidate,
      toolPermissionContext: args.effectiveToolPermissionContext,
      operation: 'read',
      behavior: 'deny',
    })
    if (deniedRule) {
      return {
        result: false,
        message: `Permission to read ${toolPath} has been denied.`,
        shouldPromptUser: false,
        blockedPath: toolPath,
        decisionReason: deniedRule,
      }
    }
  }

  for (const candidate of candidates) {
    const askedRule = matchPermissionRuleForPath({
      inputPath: candidate,
      toolPermissionContext: args.effectiveToolPermissionContext,
      operation: 'read',
      behavior: 'ask',
    })
    if (askedRule) {
      return {
        result: false,
        message: `${PRODUCT_NAME} requested permissions to read from ${toolPath}, but you haven't granted it yet.`,
        blockedPath: toolPath,
        decisionReason: askedRule,
      }
    }
  }

  const editDecision = args.checkEditPermissionForPath(toolPath)
  if (editDecision.result === true) return { result: true }

  if (
    isPathInWorkingDirectories(toolPath, args.effectiveToolPermissionContext)
  ) {
    return { result: true }
  }

  const specialReason = getSpecialAllowedReadReason({
    inputPath: toolPath,
    context: args.context,
  })
  if (specialReason) return { result: true }

  const allowRule = matchPermissionRuleForPath({
    inputPath: toolPath,
    toolPermissionContext: args.effectiveToolPermissionContext,
    operation: 'read',
    behavior: 'allow',
  })
  if (allowRule) return { result: true }

  return {
    result: false,
    message: `${PRODUCT_NAME} requested permissions to read from ${toolPath}, but you haven't granted it yet.`,
    blockedPath: toolPath,
    decisionReason: 'No allow rule matched (outside working directories)',
    requiresExplicitApproval: true,
    suggestions: suggestFilePermissionUpdates({
      inputPath: toolPath,
      operation: 'read',
      toolPermissionContext: args.effectiveToolPermissionContext,
    }),
  }
}
