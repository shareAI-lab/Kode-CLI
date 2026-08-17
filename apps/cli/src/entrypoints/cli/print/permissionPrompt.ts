import type { CanUseToolFn } from '#core/permissions/canUseTool'
import type { ToolPermissionContext } from '#core/types/toolPermissionContext'
import type { ToolPermissionContextUpdate } from '#core/types/toolPermissionContext'
import type { Tool } from '#core/tooling/Tool'
import type { ToolUseContext } from '#core/tooling/Tool'
import type { AssistantMessage } from '#core/query'
import type { KodeAgentStructuredStdio } from '#protocol/utils/kodeAgentStructuredStdio'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function getOptionalStringProperty(
  value: unknown,
  key: string,
): string | undefined {
  if (!isRecord(value)) return undefined
  const v = value[key]
  return typeof v === 'string' ? v : undefined
}

function getOptionalStringInput(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key]
  return typeof value === 'string' ? value : undefined
}

function isPermissionMode(
  value: unknown,
): value is ToolPermissionContext['mode'] {
  return value === 'acceptEdits' || value === 'cautious' || value === 'plan'
}

function isToolPermissionContextUpdate(
  value: unknown,
): value is ToolPermissionContextUpdate {
  if (!isRecord(value) || typeof value.type !== 'string') return false

  switch (value.type) {
    case 'setMode':
      return (
        isPermissionMode(value.mode) && typeof value.destination === 'string'
      )
    case 'addRules':
    case 'replaceRules':
    case 'removeRules':
      return (
        typeof value.destination === 'string' &&
        (value.behavior === 'allow' ||
          value.behavior === 'deny' ||
          value.behavior === 'ask') &&
        Array.isArray(value.rules) &&
        value.rules.every(rule => typeof rule === 'string')
      )
    case 'addDirectories':
    case 'removeDirectories':
      return (
        typeof value.destination === 'string' &&
        Array.isArray(value.directories) &&
        value.directories.every(dir => typeof dir === 'string')
      )
    default:
      return false
  }
}

type AllowResponse = {
  behavior: 'allow'
  updatedInput?: Record<string, unknown>
  updatedPermissions?: unknown
}

type DenyResponse = {
  behavior: 'deny'
  message: string
  interrupt?: boolean
}

type PromptResponse = AllowResponse | DenyResponse

export function createStdioPermissionPromptCanUseTool(args: {
  structured: KodeAgentStructuredStdio
  permissionTimeoutMs: number
  projectDir: string
  baseCanUseTool: CanUseToolFn
  getToolPermissionContext: () => ToolPermissionContext | undefined
  setToolPermissionContext: (next: ToolPermissionContext) => void
  applyToolPermissionContextUpdates: (
    context: ToolPermissionContext,
    updates: ToolPermissionContextUpdate[],
  ) => ToolPermissionContext
  persistToolPermissionUpdateToDisk: (args: {
    update: ToolPermissionContextUpdate
    projectDir: string
  }) => { persisted: boolean }
}): CanUseToolFn {
  return async (
    tool: Tool,
    input: Record<string, unknown>,
    toolUseContext: ToolUseContext,
    assistantMessage: AssistantMessage,
  ) => {
    const base = await args.baseCanUseTool(
      tool,
      input,
      toolUseContext,
      assistantMessage,
    )

    if (base.result === true) return { result: true as const }

    if (base.shouldPromptUser === false) {
      return { result: false as const, message: base.message }
    }

    try {
      const blockedPath =
        getOptionalStringProperty(base, 'blockedPath') ??
        getOptionalStringInput(input, 'file_path') ??
        getOptionalStringInput(input, 'notebook_path') ??
        getOptionalStringInput(input, 'path')

      const decisionReason = getOptionalStringProperty(base, 'decisionReason')

      const response = await args.structured.sendRequest<PromptResponse>(
        {
          subtype: 'can_use_tool',
          tool_name: tool.name,
          input,
          ...(typeof toolUseContext.toolUseId === 'string' &&
          toolUseContext.toolUseId
            ? { tool_use_id: toolUseContext.toolUseId }
            : {}),
          ...(typeof toolUseContext.agentId === 'string' &&
          toolUseContext.agentId
            ? { agent_id: toolUseContext.agentId }
            : {}),
          ...(Array.isArray(base.suggestions)
            ? { permission_suggestions: base.suggestions }
            : {}),
          ...(blockedPath ? { blocked_path: blockedPath } : {}),
          ...(decisionReason ? { decision_reason: decisionReason } : {}),
        },
        {
          signal: toolUseContext.abortController.signal,
          timeoutMs: args.permissionTimeoutMs,
        },
      )

      if (response && response.behavior === 'allow') {
        if (response.updatedInput && isRecord(response.updatedInput)) {
          Object.assign(input, response.updatedInput)
        }

        const updatedPermissionsRaw = response.updatedPermissions
        const updatedPermissions = Array.isArray(updatedPermissionsRaw)
          ? updatedPermissionsRaw.filter(isToolPermissionContextUpdate)
          : null

        const currentContext = args.getToolPermissionContext()
        if (
          updatedPermissions &&
          updatedPermissions.length > 0 &&
          currentContext
        ) {
          const next = args.applyToolPermissionContextUpdates(
            currentContext,
            updatedPermissions,
          )

          args.setToolPermissionContext(next)
          if (toolUseContext.options) {
            toolUseContext.options.toolPermissionContext = next
          }

          for (const update of updatedPermissions) {
            args.persistToolPermissionUpdateToDisk({
              update,
              projectDir: args.projectDir,
            })
          }
        }

        return { result: true as const }
      }

      if (response && response.behavior === 'deny') {
        if (response.interrupt === true) {
          toolUseContext.abortController.abort()
        }
        return { result: false as const, message: response.message }
      }

      return { result: false as const, message: base.message }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      return {
        result: false as const,
        message: `Permission prompt failed: ${msg}`,
        shouldPromptUser: false,
      }
    }
  }
}
