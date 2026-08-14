import { useCallback, useRef } from 'react'
import { hasPermissionsToUseTool } from '#core/permissions'
import type { CanUseToolFn } from '#core/permissions/canUseTool'
import { BashTool, inputSchema } from '#tools/tools/system/BashTool/BashTool'
import { getCommandSubcommandPrefix } from '#core/utils/commands'
import {
  CANCEL_MESSAGE,
  REJECT_MESSAGE,
  REJECT_MESSAGE_WITH_FEEDBACK_PREFIX,
} from '#core/utils/messages'
import { ToolUseConfirm } from '#ui-ink/components/permissions/PermissionRequest'
import { AbortError } from '#core/utils/errors'
import { logError } from '#core/utils/log'
import type { UnreachablePermissionRuleWarning } from '#core/permissions'
import { findUnreachablePermissionRules } from '#core/permissions'
import { resolveToolDescription } from '#core/tooling/Tool'

type SetState<T> = React.Dispatch<React.SetStateAction<T>>

function useCanUseTool(
  setToolUseConfirm: (confirm: ToolUseConfirm | null) => void,
  options?: {
    onPermissionRuleWarnings?: (
      warnings: UnreachablePermissionRuleWarning[],
    ) => void
  },
): CanUseToolFn {
  const onPermissionRuleWarningsRef = useRef(options?.onPermissionRuleWarnings)
  onPermissionRuleWarningsRef.current = options?.onPermissionRuleWarnings

  return useCallback<CanUseToolFn>(
    async (tool, input, toolUseContext, assistantMessage) => {
      return new Promise(resolve => {
        function resolveWithCancelledAndAbortAllToolCalls(message?: string) {
          resolve({
            result: false,
            message: message
              ? `${REJECT_MESSAGE_WITH_FEEDBACK_PREFIX}${message}`
              : CANCEL_MESSAGE,
          })
          // Trigger a synthetic assistant message in query(), to cancel
          // any other pending tool uses and stop further requests to the
          // API and wait for user input.
          toolUseContext.abortController.abort()
        }

        if (toolUseContext.abortController.signal.aborted) {
          // The turn was cancelled or timed out, not rejected by the user.
          // Use CANCEL_MESSAGE so the transcript shows a cancellation rather
          // than a misleading "User rejected" line.
          resolveWithCancelledAndAbortAllToolCalls()
          return undefined
        }

        return hasPermissionsToUseTool(
          tool,
          input,
          toolUseContext,
          assistantMessage,
        )
          .then(async result => {
            // Has permissions to use tool, granted in config
            if (result.result === true) {
              resolve({ result: true })
              return
            }

            const deniedResult = result as Extract<
              typeof result,
              { result: false }
            >

            if (deniedResult.shouldPromptUser === false) {
              resolve({ result: false, message: deniedResult.message })
              return
            }

            const [description, commandPrefix] = await Promise.all([
              resolveToolDescription(tool, input as never),
              tool === BashTool
                ? getCommandSubcommandPrefix(
                    inputSchema.parse(input).command, // already validated upstream, so ok to parse (as opposed to safeParse)
                    toolUseContext.abortController.signal,
                  )
                : Promise.resolve(null),
            ])

            if (toolUseContext.abortController.signal.aborted) {
              resolveWithCancelledAndAbortAllToolCalls()
              return
            }

            // Does not have permissions to use tool, ask the user
            setToolUseConfirm({
              assistantMessage,
              tool,
              description,
              input,
              commandPrefix,
              toolUseContext,
              suggestions: deniedResult.suggestions,
              blockedPath:
                typeof deniedResult.blockedPath === 'string'
                  ? deniedResult.blockedPath
                  : undefined,
              decisionReason:
                typeof deniedResult.decisionReason === 'string'
                  ? deniedResult.decisionReason
                  : undefined,
              riskScore:
                typeof deniedResult.riskScore === 'number'
                  ? deniedResult.riskScore
                  : null,
              onAbort() {
                resolveWithCancelledAndAbortAllToolCalls()
              },
              onAllow(type, allowOptions) {
                if (type === 'permanent') {
                  const ctx = toolUseContext.options?.toolPermissionContext
                  if (ctx) {
                    const warnings = findUnreachablePermissionRules(ctx)
                    if (warnings.length > 0) {
                      onPermissionRuleWarningsRef.current?.(warnings)
                    }
                  }
                }
                if (allowOptions?.updatedInput) {
                  resolve({
                    result: true,
                    updatedInput: allowOptions.updatedInput,
                  })
                  return
                }

                resolve({ result: true })
              },
              onReject(rejectionMessage) {
                resolveWithCancelledAndAbortAllToolCalls(rejectionMessage)
              },
            })
          })
          .catch(error => {
            if (error instanceof AbortError) {
              resolveWithCancelledAndAbortAllToolCalls()
            } else {
              logError(error)
              resolve({
                result: false,
                message:
                  'Tool use was denied because the permission check failed.',
              })
              toolUseContext.abortController.abort()
            }
          })
      })
    },
    [setToolUseConfirm],
  )
}

export default useCanUseTool
