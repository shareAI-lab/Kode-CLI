import { Tool, ToolUseContext } from '#core/tooling/Tool'

import { getCurrentProjectConfig, saveCurrentProjectConfig } from '#config'
import { logError } from '#core/utils/log'
import { grantWritePermissionForPath } from '#core/utils/permissions/filesystem'
import { persistToolPermissionUpdateToDisk } from '#core/utils/permissions/toolPermissionSettings'
import { applyToolPermissionContextUpdateForConversationKey } from '#core/utils/toolPermissionContextState'
import { getCwd } from '#core/utils/state'

import { getPermissionKey } from './permissionKey'

function readString(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  return typeof value === 'string' ? value : ''
}

export async function savePermission(
  tool: Tool,
  input: { [k: string]: unknown },
  prefix: string | null,
  context?: ToolUseContext,
): Promise<void> {
  const key = getPermissionKey(tool, input, prefix)

  // For file editing tools, store write permissions only in memory
  if (
    tool.name === 'Edit' ||
    tool.name === 'Write' ||
    tool.name === 'NotebookEdit'
  ) {
    const filePath =
      tool.name === 'NotebookEdit'
        ? readString(input, 'notebook_path')
        : readString(input, 'file_path')
    if (filePath) {
      grantWritePermissionForPath(filePath)
    }
    return
  }

  // Persistence: write allow rules to .kode/settings.local.json (legacy settings are read-compatible)
  try {
    const update = {
      type: 'addRules' as const,
      destination: 'localSettings' as const,
      behavior: 'allow' as const,
      rules: [key],
    }
    persistToolPermissionUpdateToDisk({ update, projectDir: getCwd() })

    // Keep the in-memory permission context in sync for the current conversation.
    const messageLogName = context?.options?.messageLogName
    const forkNumber = context?.options?.forkNumber ?? 0
    if (messageLogName) {
      const conversationKey = `${messageLogName}:${forkNumber}`
      const nextToolPermissionContext =
        applyToolPermissionContextUpdateForConversationKey({
          conversationKey,
          isBypassPermissionsModeAvailable: !(
            context?.options?.safeMode ?? false
          ),
          update,
        })
      // Ensure subsequent tool uses in the same turn see the updated rules.
      if (context?.options)
        context.options.toolPermissionContext = nextToolPermissionContext
    }
  } catch (error) {
    logError(error)
  }

  // For other tools, store permissions on disk
  const projectConfig = getCurrentProjectConfig()
  if (projectConfig.allowedTools.includes(key)) {
    return
  }

  projectConfig.allowedTools.push(key)
  projectConfig.allowedTools.sort()

  saveCurrentProjectConfig(projectConfig)
}
