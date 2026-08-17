import type { CanUseToolFn } from './canUseTool'
import type { PermissionResult } from './types'

import type { Tool, ToolUseContext } from '#core/tooling/Tool'
import { getCurrentProjectConfig } from '#config'
import { AbortError } from '#core/utils/errors'
import { logError } from '#core/utils/log'
import { getCwd } from '#core/utils/state'
import { PRODUCT_NAME } from '#core/constants/product'
import { getPermissionMode } from '#core/utils/permissionModeState'
import { normalizePermissionMode } from '#core/types/PermissionMode'
import { isAbsolute, resolve } from 'path'
import { resolveToolNameAlias } from '#core/utils/toolNameAliases'

import {
  createDefaultToolPermissionContext,
  type ToolPermissionContext,
  type ToolPermissionContextUpdate,
} from '#core/types/toolPermissionContext'
import {
  expandSymlinkPaths,
  getWriteSafetyCheckForPath,
  isPathInWorkingDirectories,
  isSpecialAllowedWritePathForContext,
  matchPermissionRuleForPath,
  suggestFilePermissionUpdates,
} from '#core/utils/permissions/fileToolPermissionEngine'

import { checkToolPermissionByName } from './policies/byToolName'
import { getStringFromInput } from './policies/input'

export {
  SAFE_COMMANDS,
  bashToolCommandHasExactMatchPermission,
  bashToolCommandHasPermission,
  bashToolHasPermission,
} from './policies/bash'

const FILESYSTEM_LIKE_TOOL_NAMES = new Set([
  'Read',
  'LS',
  'Edit',
  'Write',
  'NotebookEdit',
  'Glob',
  'Grep',
])

function flattenPermissionRuleGroups(
  groups: Partial<Record<string, string[]>> | undefined,
): string[] {
  if (!groups) return []
  const out: string[] = []
  for (const rules of Object.values(groups)) {
    if (!Array.isArray(rules)) continue
    for (const rule of rules) {
      if (typeof rule !== 'string') continue
      out.push(resolveToolNameAlias(rule).resolvedName)
    }
  }
  return out
}

function checkWriteSafetyFloor(args: {
  tool: Tool
  input: Record<string, unknown>
}): PermissionResult | null {
  const denyIfUnsafeWrite = (toolPath: string): PermissionResult | null => {
    const safety = getWriteSafetyCheckForPath(toolPath)
    if ('message' in safety) {
      return {
        result: false,
        message: safety.message,
        shouldPromptUser: false,
        requiresExplicitApproval: true,
      }
    }
    return null
  }

  if (args.tool.name === 'Write' || args.tool.name === 'Edit') {
    const filePath = getStringFromInput(args.input, 'file_path')
    if (filePath) return denyIfUnsafeWrite(filePath)
  }

  if (args.tool.name === 'NotebookEdit') {
    const notebookPath = getStringFromInput(args.input, 'notebook_path')
    if (notebookPath) return denyIfUnsafeWrite(notebookPath)
  }

  return null
}

function buildEffectiveContext(args: {
  toolPermissionContext: ToolPermissionContext | undefined
  permissionMode: ReturnType<typeof normalizePermissionMode>
  safeMode: boolean
  effectiveAllowedTools: string[]
  effectiveDeniedTools: string[]
  effectiveAskedTools: string[]
  commandAllowedTools: string[]
}): ToolPermissionContext {
  let effectiveToolPermissionContext =
    args.toolPermissionContext ??
    (() => {
      const fallback = createDefaultToolPermissionContext({
        isBypassPermissionsModeAvailable: !args.safeMode,
      })
      fallback.mode = args.permissionMode
      if (args.effectiveAllowedTools.length > 0) {
        fallback.alwaysAllowRules.localSettings = args.effectiveAllowedTools
      }
      if (args.effectiveDeniedTools.length > 0) {
        fallback.alwaysDenyRules.localSettings = args.effectiveDeniedTools
      }
      if (args.effectiveAskedTools.length > 0) {
        fallback.alwaysAskRules.localSettings = args.effectiveAskedTools
      }
      return fallback
    })()

  if (args.toolPermissionContext) {
    effectiveToolPermissionContext = {
      ...args.toolPermissionContext,
      alwaysAllowRules: { ...args.toolPermissionContext.alwaysAllowRules },
      alwaysDenyRules: { ...args.toolPermissionContext.alwaysDenyRules },
      alwaysAskRules: { ...args.toolPermissionContext.alwaysAskRules },
    }
  }

  // Per-command allowedTools (e.g. `Read(~/**)`) must participate in the same
  // rule engine as persisted permission rules.
  if (args.commandAllowedTools.length > 0) {
    const existing =
      effectiveToolPermissionContext.alwaysAllowRules.command ?? []
    effectiveToolPermissionContext.alwaysAllowRules.command = [
      ...new Set([...existing, ...args.commandAllowedTools]),
    ]
  }

  return effectiveToolPermissionContext
}

function isReadOnlyToolUse(
  tool: Tool,
  input: Record<string, unknown>,
): boolean {
  try {
    return tool.isReadOnly(input as never)
  } catch (error) {
    logError(`Error checking whether ${tool.name} is read-only: ${error}`)
    return false
  }
}

export const hasPermissionsToUseTool: CanUseToolFn = async (
  tool,
  input,
  context,
  assistantMessage,
): Promise<PermissionResult> => {
  const rawPermissionMode = getPermissionMode(context)
  const normalizedPermissionMode = normalizePermissionMode(rawPermissionMode)
  const shouldAvoidPermissionPrompts =
    context.options?.shouldAvoidPermissionPrompts === true
  const safeMode = Boolean(context.options?.safeMode ?? context.safeMode)
  const permissionMode =
    safeMode && normalizedPermissionMode === 'acceptEdits'
      ? 'cautious'
      : normalizedPermissionMode
  const isEditMode = permissionMode === 'acceptEdits'
  const requiresUserInteraction =
    tool.requiresUserInteraction?.(input as never) ?? false

  const safetyFloor = checkWriteSafetyFloor({ tool, input })
  if (safetyFloor) return safetyFloor

  const promptsUnavailableDenied: PermissionResult = {
    result: false,
    message: `Permission to use ${tool.name} has been auto-denied (prompts unavailable).`,
    shouldPromptUser: false,
  }

  if (requiresUserInteraction) {
    if (shouldAvoidPermissionPrompts) return promptsUnavailableDenied
    return {
      result: false,
      message: `${PRODUCT_NAME} requested permissions to use ${tool.name}, but you haven't granted it yet.`,
    }
  }

  // Plan is a real execution boundary, not merely a UI label. Every call is
  // classified using its actual input: Read remains usable, while Edit,
  // Write, dangerous Bash commands, and write-capable delegation are denied.
  // Tools that require user interaction (for example ExitPlanMode) were
  // handled above so an explicit approval can intentionally change modes.
  if (permissionMode === 'plan') {
    if (!isReadOnlyToolUse(tool, input)) {
      return {
        result: false,
        message: `${tool.name} is unavailable in read-only Plan mode. Exit Plan mode and explicitly choose an editing permission mode to continue.`,
        shouldPromptUser: false,
      }
    }
  }

  if (context.abortController.signal.aborted) {
    throw new AbortError()
  }

  const isFilesystemLikeTool = FILESYSTEM_LIKE_TOOL_NAMES.has(tool.name)
  if (!isFilesystemLikeTool) {
    try {
      if (!tool.needsPermissions(input as never)) {
        return { result: true }
      }
    } catch (error) {
      logError(`Error checking permissions: ${error}`)
      return { result: false, message: 'Error checking permissions' }
    }
  }

  const projectConfig = getCurrentProjectConfig()
  const toolPermissionContext = context.options?.toolPermissionContext
  const normalizeToolRule = (rule: string) =>
    resolveToolNameAlias(rule).resolvedName
  const allowedTools = toolPermissionContext
    ? flattenPermissionRuleGroups(toolPermissionContext.alwaysAllowRules)
    : (projectConfig.allowedTools ?? []).map(normalizeToolRule)
  const deniedTools = toolPermissionContext
    ? flattenPermissionRuleGroups(toolPermissionContext.alwaysDenyRules)
    : (projectConfig.deniedTools ?? []).map(normalizeToolRule)
  const askedTools = toolPermissionContext
    ? flattenPermissionRuleGroups(toolPermissionContext.alwaysAskRules)
    : (projectConfig.askedTools ?? []).map(normalizeToolRule)
  const commandAllowedTools = Array.isArray(
    context.options?.commandAllowedTools,
  )
    ? context.options.commandAllowedTools
    : []

  const effectiveAllowedTools = [
    ...new Set([...allowedTools, ...commandAllowedTools]),
  ]
  const effectiveDeniedTools = [...new Set(deniedTools)]
  const effectiveAskedTools = [...new Set(askedTools)]

  if (tool.name === 'Bash' && effectiveAllowedTools.includes('Bash')) {
    return { result: true }
  }

  const effectiveToolPermissionContext = buildEffectiveContext({
    toolPermissionContext,
    permissionMode,
    safeMode,
    effectiveAllowedTools,
    effectiveDeniedTools,
    effectiveAskedTools,
    commandAllowedTools,
  })

  const checkEditPermissionForPath = (toolPath: string): PermissionResult => {
    const candidates = expandSymlinkPaths(toolPath)

    for (const candidate of candidates) {
      const deniedRule = matchPermissionRuleForPath({
        inputPath: candidate,
        toolPermissionContext: effectiveToolPermissionContext,
        operation: 'edit',
        behavior: 'deny',
      })
      if (deniedRule) {
        return {
          result: false,
          message: `Permission to edit ${toolPath} has been denied.`,
          shouldPromptUser: false,
          blockedPath: toolPath,
          decisionReason: deniedRule,
        }
      }
    }

    if (isSpecialAllowedWritePathForContext({ inputPath: toolPath, context })) {
      return { result: true }
    }

    const safety = getWriteSafetyCheckForPath(toolPath)
    if ('message' in safety) {
      return {
        result: false,
        message: safety.message,
        blockedPath: toolPath,
        decisionReason: safety.message,
        requiresExplicitApproval: true,
      }
    }

    for (const candidate of candidates) {
      const askedRule = matchPermissionRuleForPath({
        inputPath: candidate,
        toolPermissionContext: effectiveToolPermissionContext,
        operation: 'edit',
        behavior: 'ask',
      })
      if (askedRule) {
        return {
          result: false,
          message: `${PRODUCT_NAME} requested permissions to write to ${toolPath}, but you haven't granted it yet.`,
          blockedPath: toolPath,
          decisionReason: askedRule,
          requiresExplicitApproval: true,
        }
      }
    }

    const inWorkingDirs = isPathInWorkingDirectories(
      toolPath,
      effectiveToolPermissionContext,
    )
    if (
      effectiveToolPermissionContext.mode === 'acceptEdits' &&
      inWorkingDirs
    ) {
      return { result: true }
    }

    const allowRule = matchPermissionRuleForPath({
      inputPath: toolPath,
      toolPermissionContext: effectiveToolPermissionContext,
      operation: 'edit',
      behavior: 'allow',
    })
    if (allowRule) return { result: true }

    return {
      result: false,
      message: `${PRODUCT_NAME} requested permissions to write to ${toolPath}, but you haven't granted it yet.`,
      blockedPath: toolPath,
      decisionReason: 'No allow rule matched (outside working directories)',
      requiresExplicitApproval: true,
      suggestions: suggestFilePermissionUpdates({
        inputPath: toolPath,
        operation: 'write',
        toolPermissionContext: effectiveToolPermissionContext,
      }),
    }
  }

  const permissionResult = await checkToolPermissionByName({
    tool,
    input,
    context,
    assistantMessage,
    effectiveAllowedTools,
    effectiveDeniedTools,
    effectiveAskedTools,
    effectiveToolPermissionContext,
    checkEditPermissionForPath,
  })

  // Edit mode auto-approves ordinary requests before the headless fallback
  // turns unavailable prompts into denials. Explicit ask rules and protected
  // boundaries set requiresExplicitApproval and remain promptable/blocked.
  if (
    isEditMode &&
    !requiresUserInteraction &&
    permissionResult.result === false &&
    permissionResult.shouldPromptUser !== false &&
    permissionResult.requiresExplicitApproval !== true
  ) {
    return { result: true }
  }

  if (
    shouldAvoidPermissionPrompts &&
    permissionResult.result === false &&
    permissionResult.shouldPromptUser !== false
  ) {
    return promptsUnavailableDenied
  }

  return permissionResult
}

export type { ToolPermissionContextUpdate }
