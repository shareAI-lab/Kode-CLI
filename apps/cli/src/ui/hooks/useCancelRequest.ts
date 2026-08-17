import { ToolUseConfirm } from '#ui-ink/components/permissions/PermissionRequest'
import { BinaryFeedbackContext } from '#ui-ink/screens/REPL'
import type { SetToolJSXFn } from '#core/tooling/Tool'
import type { ReactNode } from 'react'
import { useKeypress } from '#ui-ink/hooks/useKeypress'
import { KEYPRESS_PRIORITY } from '#ui-ink/constants/keypressPriority'

export function shouldHandleCancelRequest(args: {
  wantsCancel: boolean
  isLoading: boolean
  isMessageSelectorVisible: boolean
  abortSignal?: AbortSignal
}): boolean {
  return (
    args.wantsCancel &&
    args.isLoading &&
    !args.isMessageSelectorVisible &&
    Boolean(args.abortSignal) &&
    !args.abortSignal?.aborted
  )
}

export function useCancelRequest(
  setToolJSX: SetToolJSXFn<ReactNode>,
  setToolUseConfirm: (toolUseConfirm: ToolUseConfirm | null) => void,
  setBinaryFeedbackContext: (bfContext: BinaryFeedbackContext | null) => void,
  onCancel: () => void,
  getIsLoading: () => boolean,
  isMessageSelectorVisible: boolean,
  getAbortSignal: () => AbortSignal | undefined,
) {
  useKeypress(
    (input, key) => {
      const wantsCancel =
        key.escape || (key.ctrl && input.toLowerCase() === 'c')
      if (
        !shouldHandleCancelRequest({
          wantsCancel,
          isLoading: getIsLoading(),
          isMessageSelectorVisible,
          abortSignal: getAbortSignal(),
        })
      ) {
        // Esc closes the message selector
        return undefined
      }

      setToolJSX(null)
      setToolUseConfirm(null)
      setBinaryFeedbackContext(null)
      onCancel()
      return true
    },
    { priority: KEYPRESS_PRIORITY.REPL_CONTROLLER + 1 },
  )
}
