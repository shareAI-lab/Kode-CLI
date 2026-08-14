import type { ToolUseContext } from '@kode/tool-interface/Tool'
import type { ToolUseLikeBlockParam } from '@kode/protocol/anthropic'
import { logError } from '#core/utils/log'
import { createUserMessage } from '../messages/create'
import {
  debug as debugLogger,
  getCurrentRequest,
  logUserFriendly,
} from '#core/utils/debugLogger'
import { resolveToolNameAlias } from '#core/utils/toolNameAliases'
import { setRequestStatus } from '#core/utils/requestStatus'

import type {
  AssistantMessage,
  EngineCanUseToolFn,
  ExtendedToolUseContext,
  Message,
} from './types'
import { checkPermissionsAndCallTool } from './tool-call'

export async function* runToolUse(
  toolUse: ToolUseLikeBlockParam,
  siblingToolUseIDs: Set<string>,
  assistantMessage: AssistantMessage,
  canUseTool: EngineCanUseToolFn,
  toolUseContext: ExtendedToolUseContext,
  shouldSkipPermissionCheck?: boolean,
  enforceReadMode = false,
): AsyncGenerator<Message, void> {
  const currentRequest = getCurrentRequest()
  const aliasResolution = resolveToolNameAlias(toolUse.name)
  setRequestStatus({ kind: 'tool', detail: aliasResolution.resolvedName })

  debugLogger.flow('TOOL_USE_START', {
    toolName: toolUse.name,
    toolUseID: toolUse.id,
    inputSize: JSON.stringify(toolUse.input).length,
    siblingToolCount: siblingToolUseIDs.size,
    shouldSkipPermissionCheck: Boolean(shouldSkipPermissionCheck),
    requestId: currentRequest?.id,
  })

  logUserFriendly(
    'TOOL_EXECUTION',
    {
      toolName: toolUse.name,
      action: 'Starting',
      target: toolUse.input ? Object.keys(toolUse.input).join(', ') : '',
    },
    currentRequest?.id,
  )

  const toolName = aliasResolution.resolvedName
  const tool = toolUseContext.options.tools.find(t => t.name === toolName)
  if (!tool) {
    debugLogger.error('TOOL_NOT_FOUND', {
      requestedTool: toolName,
      availableTools: toolUseContext.options.tools.map(t => t.name),
      toolUseID: toolUse.id,
      requestId: currentRequest?.id,
    })

    const notFoundMessage = aliasResolution.wasAliased
      ? `Error: No such tool available: ${aliasResolution.originalName} (resolved to ${toolName})`
      : `Error: No such tool available: ${toolName}`

    yield createUserMessage([
      {
        type: 'tool_result',
        content: notFoundMessage,
        is_error: true,
        tool_use_id: toolUse.id,
      },
    ])
    return
  }

  const toolInput = toolUse.input as Record<string, unknown>

  debugLogger.flow('TOOL_VALIDATION_START', {
    toolName: tool.name,
    toolUseID: toolUse.id,
    inputKeys: Object.keys(toolInput),
    requestId: currentRequest?.id,
  })

  try {
    for await (const message of checkPermissionsAndCallTool(
      tool,
      toolUse.id,
      siblingToolUseIDs,
      toolInput,
      toolUseContext as ToolUseContext,
      canUseTool,
      assistantMessage,
      shouldSkipPermissionCheck,
      enforceReadMode,
    )) {
      yield message
    }
  } catch (e) {
    logError(e)

    yield createUserMessage([
      {
        type: 'tool_result',
        content: `Tool execution failed: ${e instanceof Error ? e.message : String(e)}`,
        is_error: true,
        tool_use_id: toolUse.id,
      },
    ])
  }
}
