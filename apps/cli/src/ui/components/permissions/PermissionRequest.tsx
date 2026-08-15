import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Tool } from '#core/tooling/Tool'
import { AssistantMessage } from '#core/query'
import type { ToolUseContext } from '#core/tooling/Tool'
import { FileEditTool } from '#tools/tools/filesystem/FileEditTool/FileEditTool'
import { FileWriteTool } from '#tools/tools/filesystem/FileWriteTool/FileWriteTool'
import { BashTool } from '#tools/tools/system/BashTool/BashTool'
import { FileEditPermissionRequest } from './FileEditPermissionRequest/FileEditPermissionRequest'
import { BashPermissionRequest } from './BashPermissionRequest/BashPermissionRequest'
import { FallbackPermissionRequest } from './FallbackPermissionRequest'
import { useNotifyAfterTimeout } from '#ui-ink/hooks/useNotifyAfterTimeout'
import { FileWritePermissionRequest } from './FileWritePermissionRequest/FileWritePermissionRequest'
import { type CommandSubcommandPrefixResult } from '#core/utils/commands'
import { FilesystemPermissionRequest } from './FilesystemPermissionRequest/FilesystemPermissionRequest'
import { NotebookEditTool } from '#tools/tools/filesystem/NotebookEditTool/NotebookEditTool'
import { GlobTool } from '#tools/tools/filesystem/GlobTool/GlobTool'
import { GrepTool } from '#tools/tools/search/GrepTool/GrepTool'
import { FileReadTool } from '#tools/tools/filesystem/FileReadTool/FileReadTool'
import { PRODUCT_NAME } from '#core/constants/product'
import { SlashCommandTool } from '#tools/tools/interaction/SlashCommandTool/SlashCommandTool'
import { SkillTool } from '#tools/tools/interaction/SkillTool/SkillTool'
import { SlashCommandPermissionRequest } from './SlashCommandPermissionRequest/SlashCommandPermissionRequest'
import { SkillPermissionRequest } from './SkillPermissionRequest/SkillPermissionRequest'
import { WebFetchTool } from '#tools/tools/network/WebFetchTool/WebFetchTool'
import { WebFetchPermissionRequest } from './WebFetchPermissionRequest/WebFetchPermissionRequest'
import { ExitPlanModeTool } from '#tools/tools/interaction/PlanModeTool/ExitPlanModeTool'
import { ExitPlanModePermissionRequest } from './PlanModePermissionRequest/ExitPlanModePermissionRequest'
import { AskUserQuestionTool } from '#tools/tools/interaction/AskUserQuestionTool/AskUserQuestionTool'
import { AskUserQuestionPermissionRequest } from './AskUserQuestionPermissionRequest/AskUserQuestionPermissionRequest'
import type { ToolPermissionContextUpdate } from '#core/types/toolPermissionContext'
import { useKeypress } from '#ui-ink/hooks/useKeypress'
import { KEYPRESS_PRIORITY } from '#ui-ink/constants/keypressPriority'
import { Box, Text } from 'ink'
import { getTheme } from '#core/utils/theme'

function permissionComponentForTool(tool: Tool) {
  switch (tool) {
    case FileEditTool:
      return FileEditPermissionRequest
    case FileWriteTool:
      return FileWritePermissionRequest
    case BashTool:
      return BashPermissionRequest
    case GlobTool:
    case GrepTool:
    case FileReadTool:
    case NotebookEditTool:
      return FilesystemPermissionRequest
    case SlashCommandTool:
      return SlashCommandPermissionRequest
    case SkillTool:
      return SkillPermissionRequest
    case WebFetchTool:
      return WebFetchPermissionRequest
    case ExitPlanModeTool:
      return ExitPlanModePermissionRequest
    case AskUserQuestionTool:
      return AskUserQuestionPermissionRequest
    default:
      return FallbackPermissionRequest
  }
}

export type PermissionRequestProps = {
  toolUseConfirm: ToolUseConfirm
  onDone(): void
  verbose: boolean
  /**
   * Number of additional permission requests waiting behind the current one.
   * When > 0 a batch action bar is shown.
   */
  pendingCount?: number
  onAllowAllPending?(): void
  onRejectAllPending?(): void
}

export function toolUseConfirmGetPrefix(
  toolUseConfirm: ToolUseConfirm,
): string | null {
  const prefix = toolUseConfirm.commandPrefix
  if (!prefix) return null
  if (prefix.commandInjectionDetected) return null
  if (!('commandPrefix' in prefix)) return null
  return prefix.commandPrefix ?? null
}

export type ToolUseConfirm = {
  assistantMessage: AssistantMessage
  tool: Tool
  description: string
  input: { [key: string]: unknown }
  commandPrefix: CommandSubcommandPrefixResult | null
  toolUseContext: ToolUseContext
  suggestions?: ToolPermissionContextUpdate[]
  blockedPath?: string
  decisionReason?: string
  // NOTE: riskScore is carried through to support current permission UX.
  riskScore: number | null
  onAbort(): void
  onAllow(
    type: 'permanent' | 'temporary',
    options?: { updatedInput?: { [key: string]: unknown } },
  ): void
  onReject(rejectionMessage?: string): void
}

// NOTE: Permission rendering is centralized to keep UX consistent across tools/hosts.
// First batch keypress only arms the action; the second one executes it.
// Queued requests were never reviewed by the user, so a single stray Ctrl+A
// (or Ctrl+D) must not act on all of them.
const BATCH_ARM_TIMEOUT_MS = 5_000

export function PermissionRequest({
  toolUseConfirm,
  onDone,
  verbose,
  pendingCount = 0,
  onAllowAllPending,
  onRejectAllPending,
}: PermissionRequestProps): React.ReactNode {
  const [batchArmed, setBatchArmed] = useState<'allow' | 'deny' | null>(null)
  const batchArmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (batchArmTimeoutRef.current) {
        clearTimeout(batchArmTimeoutRef.current)
        batchArmTimeoutRef.current = null
      }
    }
  }, [])

  const armBatch = (kind: 'allow' | 'deny'): boolean => {
    if (batchArmed !== kind) {
      setBatchArmed(kind)
      if (batchArmTimeoutRef.current) {
        clearTimeout(batchArmTimeoutRef.current)
      }
      batchArmTimeoutRef.current = setTimeout(() => {
        batchArmTimeoutRef.current = null
        setBatchArmed(null)
      }, BATCH_ARM_TIMEOUT_MS)
      return false
    }
    if (batchArmTimeoutRef.current) {
      clearTimeout(batchArmTimeoutRef.current)
      batchArmTimeoutRef.current = null
    }
    setBatchArmed(null)
    return true
  }

  // Handle Ctrl+C and Esc (reject).
  useKeypress(
    (input, key) => {
      if (key.ctrl && input === 'c') {
        onDone()
        toolUseConfirm.onReject()
        return true
      }

      if (key.escape) {
        onDone()
        toolUseConfirm.onReject()
        return true
      }

      // Batch actions only make sense while requests are queued behind the
      // currently shown dialog. Ctrl+A resolves every pending request with a
      // one-time allow; Ctrl+D rejects them all. Both need a second press to
      // actually run (armed state), so a stray key cannot approve requests the
      // user never reviewed.
      if (pendingCount > 1 && key.ctrl && input === 'a') {
        if (armBatch('allow')) onAllowAllPending?.()
        return true
      }

      if (pendingCount > 1 && key.ctrl && input === 'd') {
        if (armBatch('deny')) onRejectAllPending?.()
        return true
      }
      return undefined
    },
    // Above REPL cancel (51) so Esc denies this tool instead of aborting the
    // turn. Tool-specific handlers that must run first should use INLINE_TOOL+1.
    { priority: KEYPRESS_PRIORITY.INLINE_TOOL },
  )

  const toolName =
    toolUseConfirm.tool.userFacingName?.() || toolUseConfirm.tool.name || 'Tool'
  useNotifyAfterTimeout(
    `${PRODUCT_NAME} needs your permission to use ${toolName}`,
  )

  const PermissionComponent = permissionComponentForTool(toolUseConfirm.tool)

  return (
    <>
      {pendingCount > 1 ? (
        <Box flexDirection="row" gap={1} paddingX={2} marginTop={1}>
          {batchArmed === null ? (
            <>
              <Text
                dimColor
              >{`${pendingCount - 1} more request${pendingCount - 1 > 1 ? 's' : ''} waiting`}</Text>
              <Text color={getTheme().success}>Ctrl+A allow all</Text>
              <Text dimColor>·</Text>
              <Text color={getTheme().error}>Ctrl+D deny all</Text>
            </>
          ) : (
            <Text dimColor>
              {batchArmed === 'allow'
                ? `Press Ctrl+A again to allow all ${pendingCount} requests`
                : `Press Ctrl+D again to deny all ${pendingCount} requests`}
            </Text>
          )}
        </Box>
      ) : null}
      <PermissionComponent
        toolUseConfirm={toolUseConfirm}
        onDone={onDone}
        verbose={verbose}
      />
    </>
  )
}
