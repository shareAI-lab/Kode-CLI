import { Box } from 'ink'
import * as React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactReconciler from 'react-reconciler'
import { Logo } from '#ui-ink/components/Logo'
import ProjectOnboarding from '#ui-ink/components/ProjectOnboarding'
import type { ToolUseConfirm } from '#ui-ink/components/permissions/PermissionRequest'
import PromptInput from '#ui-ink/components/PromptInput'
import type { BinaryFeedbackResult } from '#core/query'
import { getTotalCost } from '#core/cost-tracker'
import { useCostSummary } from '#ui-ink/hooks/useCostSummary'
import { useLogStartupTime } from '#ui-ink/hooks/useLogStartupTime'
import {
  useApiKeyVerification,
  type VerificationStatus,
} from '#ui-ink/hooks/useApiKeyVerification'
import { useCancelRequest } from '#ui-ink/hooks/useCancelRequest'
import useCanUseTool from '#ui-ink/hooks/useCanUseTool'
import { useLogMessages } from '#ui-ink/hooks/useLogMessages'
import {
  setMessagesGetter,
  setMessagesSetter,
  setModelConfigChangeHandler,
  type MessageStateSetter,
} from '#core/messages'
import type { Message as MessageType } from '#core/query'
import { createUserMessage, normalizeMessages } from '#core/utils/messages'
import {
  getGlobalConfigCached,
  isExperimentalVoiceEnabled,
  saveGlobalConfig,
} from '#core/utils/config'
import { getNextAvailableLogForkNumber, logError } from '#core/utils/log'
import { getCwd, getOriginalCwd } from '#core/utils/state'
import {
  claimDueSchedules,
  getUnstartedGoalRunSchedule,
  GoalService,
  type ClaimedSchedule,
} from '#core/goals'
import { getKodeAgentSessionId } from '#protocol/utils/kodeAgentSessionId'
import { MACRO } from '#core/constants/macros'
import { subscribeAgentReloads } from '@kode/agent/events'
import { subscribeCustomCommandReloads } from '#cli-services/customCommands'
import { useKeypress } from '#ui-ink/hooks/useKeypress'
import { useToolKeypress } from '#ui-ink/hooks/useToolKeypress'
import { useTerminalSize } from '#ui-ink/hooks/useTerminalSize'
import { submitPrompt } from '#ui-ink/components/PromptInput/submit'
import { parsePromptHistoryDisplay } from '#ui-ink/hooks/useArrowKeyHistory'
import { useTranscriptItems, type TranscriptItem } from './useTranscriptItems'
import { useRequestToolUsePermission } from './useRequestToolUsePermission'
import { useReplQuery } from './useReplQuery'
import { useReplInit } from './useReplInit'
import { transitionToolUseConfirmQueue } from './toolUseConfirmQueue'
import { buildPromptInputProps } from './promptInputProps'
import { useMessageSelectorSelect } from './useMessageSelectorSelect'
import { buildStartupHeaderIdentityKey } from './startupHeaderIdentity'
import type { BinaryFeedbackContext, REPLProps } from './types'
import {
  createAssistantStreamStore,
  type AssistantStreamStore,
} from './assistantStreamStore'
import { ensureLspManagerInitialized } from '#tools/tools/system/LspTool/call'
import { prewarmLlmRuntime } from '#core/ai/llmLazy'
import { describeToolPermissionRuleSource } from '#core/permissions/ruleString'
import { triggerModelConfigChange } from '#core/messages'
import {
  clearViewport,
  enterAlternateScreen,
  exitAlternateScreen,
} from '#cli-utils/terminal'
import { requestCliExit } from '#cli-utils/exit'
import { getModelManager } from '#core/utils/model'
import { getToolPermissionContextForConversationKey } from '#core/utils/toolPermissionContextState'
import type { PromptMode } from '#ui-ink/components/PromptInput/types'
import type {
  PastedImageAttachment,
  PastedTextSegment,
} from '#ui-ink/components/PromptInput/pasteTypes'
import { KEYPRESS_PRIORITY } from '#ui-ink/constants/keypressPriority'
import { terminalCapabilityManager } from '#ui-ink/utils/terminalCapabilityManager'
import type {
  ForkConvoWithMessagesOptions,
  SetForkConvoWithMessagesOnTheNextRender,
} from '#ui-ink/types/conversationReset'
import type { ToolKeypressHandler } from '@kode/tool-interface/Tool'
import type { WrappedClient } from '#core/mcp/client'
import type { Tool } from '#core/tooling/Tool'

const EMPTY_MCP_CLIENTS = [] as NonNullable<REPLProps['mcpClients']>

const batchedUpdates: ((fn: () => void) => void) | null =
  typeof (ReactReconciler as any)?.batchedUpdates === 'function'
    ? ((ReactReconciler as any).batchedUpdates as (fn: () => void) => void)
    : typeof (ReactReconciler as any)?.default?.batchedUpdates === 'function'
      ? ((ReactReconciler as any).default.batchedUpdates as (
          fn: () => void,
        ) => void)
      : null

function isSuppressedTranscriptItem(
  item: TranscriptItem,
  suppressedMessageIds: ReadonlySet<string>,
): boolean {
  for (const messageId of suppressedMessageIds) {
    if (item.key === messageId || item.key.startsWith(`${messageId}:`)) {
      return true
    }
  }
  return false
}

export function useReplController(props: REPLProps) {
  const debug = props.debug ?? false
  const disableSlashCommands = props.disableSlashCommands ?? false
  const safeMode = Boolean(props.safeMode)
  const isDefaultModel = props.isDefaultModel ?? true
  const { rows: terminalRows, columns: terminalColumns } = useTerminalSize()
  const assistantStreamStoreRef = useRef<AssistantStreamStore | null>(null)
  if (assistantStreamStoreRef.current === null) {
    assistantStreamStoreRef.current = createAssistantStreamStore()
  }
  const assistantStreamStore = assistantStreamStoreRef.current

  useEffect(
    () => () => {
      assistantStreamStore.destroy()
    },
    [assistantStreamStore],
  )
  const [updateAvailableVersion, setUpdateAvailableVersion] = useState<
    string | null
  >(() => props.initialUpdateVersion ?? null)
  const [updateCommands, setUpdateCommands] = useState<string[] | null>(() =>
    props.initialUpdateCommands ? [...props.initialUpdateCommands] : null,
  )

  const [verbose, setVerbose] = useState(() => {
    return props.verbose ?? getGlobalConfigCached().verbose
  })

  const [commands, setCommands] = useState(() => props.commands)

  const hasDeferredRuntime = Boolean(
    props.toolsPromise || props.commandsPromise || props.mcpClientsPromise,
  )
  const [tools, setTools] = useState<Tool[]>(() => props.tools ?? [])
  const [mcpClients, setMcpClients] = useState<WrappedClient[]>(() =>
    props.mcpClients ?? EMPTY_MCP_CLIENTS,
  )
  const runtimeReadyRef = useRef<Promise<void>>(
    hasDeferredRuntime ? new Promise<void>(() => {}) : Promise.resolve(),
  )

  useEffect(() => {
    if (!hasDeferredRuntime) return undefined
    let cancelled = false
    void Promise.all([
      props.toolsPromise ?? Promise.resolve(undefined),
      props.commandsPromise ?? Promise.resolve(undefined),
      props.mcpClientsPromise ?? Promise.resolve(undefined),
    ])
      .then(([nextTools, nextCommands, nextMcpClients]) => {
        if (cancelled) return
        if (nextTools) setTools(nextTools)
        if (nextCommands) setCommands(nextCommands)
        if (nextMcpClients) setMcpClients(nextMcpClients)
      })
      .catch(error => {
        if (cancelled) return
        logError(error)
      })
      .finally(() => {
        if (cancelled) return
        runtimeReadyRef.current = Promise.resolve()
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (process.env.NODE_ENV === 'test') return undefined
    if (updateAvailableVersion || updateCommands) return undefined

    let cancelled = false
    ;(async () => {
      try {
        const [{ getLatestVersion, getUpdateCommandSuggestions }, semverMod] =
          await Promise.all([
            import('#core/utils/autoUpdater'),
            import('semver'),
          ])

        const semverModule = semverMod as unknown as Record<string, unknown>
        const semver =
          typeof semverModule.gt === 'function'
            ? semverModule
            : typeof (semverModule.default as any)?.gt === 'function'
              ? (semverModule.default as any)
              : null
        if (!semver) return

        const latest = await getLatestVersion()
        if (!latest || typeof latest !== 'string') return

        if (!semver.gt(latest, MACRO.VERSION)) return
        const cmds = await getUpdateCommandSuggestions()

        if (cancelled) return
        setUpdateAvailableVersion(latest)
        setUpdateCommands(cmds)
      } catch {
        // best-effort only
      }
    })()

    return () => {
      cancelled = true
    }
  }, [updateAvailableVersion, updateCommands])

  const [forkNumber, setForkNumber] = useState(
    getNextAvailableLogForkNumber(
      props.messageLogName,
      props.initialForkNumber ?? 0,
      0,
    ),
  )
  const initialForkNumberRef = useRef(forkNumber)
  const [staticOutputEpoch, setStaticOutputEpoch] = useState(0)
  const suppressedTranscriptMessageIdsRef = useRef<Set<string>>(new Set())
  const [uiRefreshCounter, setUiRefreshCounter] = useState(0)

  const [pendingForkConvoWithMessages, setPendingForkConvoWithMessages] =
    useState<{
      messages: MessageType[]
      options?: ForkConvoWithMessagesOptions
    } | null>(null)
  const pendingForkConvoWithMessagesRef = useRef<{
    messages: MessageType[]
    options?: ForkConvoWithMessagesOptions
  } | null>(null)
  const pendingForkApplySeqRef = useRef(0)
  const isMountedRef = useRef(true)

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const setForkConvoWithMessagesOnTheNextRender =
    useCallback<SetForkConvoWithMessagesOnTheNextRender>(
      (messages, options) => {
        const request = { messages, options }
        pendingForkConvoWithMessagesRef.current = request
        setPendingForkConvoWithMessages(request)
      },
      [],
    )

  // Returns true if a pending fork/reset request should suppress appending new messages.
  // Side effect: clears pendingForkConvoWithMessagesRef when returning true.
  const checkPendingForkAndSuppressAppend = useCallback(
    (newMessages: MessageType[]): boolean => {
      const pending = pendingForkConvoWithMessagesRef.current
      if (!pending) return false
      if (newMessages.length === 0) return false
      const last = newMessages[newMessages.length - 1]
      if (!last || last.type !== 'assistant') return false
      // A fork/reset was requested during this command; don't append the
      // command metadata messages to the soon-to-be-replaced transcript.
      pendingForkConvoWithMessagesRef.current = null
      return true
    },
    [],
  )

  const [abortController, setAbortControllerState] =
    useState<AbortController | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const setAbortController = useCallback(
    (nextController: AbortController | null) => {
      abortControllerRef.current = nextController
      setAbortControllerState(nextController)
    },
    [],
  )
  const clearAbortController = useCallback(
    (completedController: AbortController) => {
      if (abortControllerRef.current !== completedController) return false
      abortControllerRef.current = null
      setAbortControllerState(currentController =>
        currentController === completedController ? null : currentController,
      )
      return true
    },
    [],
  )
  const [isLoading, setIsLoadingState] = useState(false)
  const isLoadingRef = useRef(false)
  const setIsLoading = useCallback((nextIsLoading: boolean) => {
    isLoadingRef.current = nextIsLoading
    setIsLoadingState(current =>
      current === nextIsLoading ? current : nextIsLoading,
    )
  }, [])
  const [cancelRequestKey, setCancelRequestKey] = useState(0)
  type ToolView = {
    jsx: React.ReactNode | null
    shouldHidePromptInput: boolean
    displayMode?: 'inline' | 'fullscreen'
    onKeypress?: ToolKeypressHandler
  }

  const [toolViewStack, setToolViewStack] = useState<ToolView[]>([])
  const toolViewStackRef = useRef<ToolView[]>(toolViewStack)
  useEffect(() => {
    toolViewStackRef.current = toolViewStack
  }, [toolViewStack])

  const toolJSX: ToolView | null =
    toolViewStack.length > 0 ? toolViewStack[toolViewStack.length - 1]! : null

  useToolKeypress(toolJSX?.onKeypress)

  const toolJSXRef = useRef<typeof toolJSX>(toolJSX)
  useEffect(() => {
    toolJSXRef.current = toolJSX
  }, [toolJSX])

  const ephemeralFullscreenAltScreenRef = useRef(false)
  useEffect(() => {
    return () => {
      if (ephemeralFullscreenAltScreenRef.current) {
        ephemeralFullscreenAltScreenRef.current = false
        exitAlternateScreen()
      }
    }
  }, [])

  const setToolViewStackWithClear = useCallback(
    (nextStack: ToolView[]) => {
      const prevMode = toolJSXRef.current?.displayMode
      const nextTop = nextStack.length ? nextStack[nextStack.length - 1]! : null
      const nextMode = nextTop?.displayMode

      const prevFull = prevMode === 'fullscreen'
      const nextFull = nextMode === 'fullscreen'

      const maybeApplyPendingForkConvoWithMessages = (
        afterApply?: () => void,
      ): boolean => {
        const request = pendingForkConvoWithMessagesRef.current
        if (!request) return false
        const applySeq = ++pendingForkApplySeqRef.current

        pendingForkConvoWithMessagesRef.current = null

        const applyStateUpdates = () => {
          setPendingForkConvoWithMessages(null)
          setForkNumber(prev => prev + 1)
          setStaticOutputEpoch(prev => prev + 1)
          setMessages(request.messages)

          if (request.options?.resetInput) {
            setInputMode('prompt')
            setInputValue('')
            setRestorePastes(undefined)
            setDraftPastes({ pastedTexts: [], pastedImages: [] })
          }
        }

        const applyAll = () => {
          if (batchedUpdates) {
            batchedUpdates(() => {
              applyStateUpdates()
              afterApply?.()
            })
            return
          }
          applyStateUpdates()
          afterApply?.()
        }

        if (!request.options?.clearViewport) {
          applyAll()
          return true
        }

        void (async () => {
          await clearViewport()
          if (
            !isMountedRef.current ||
            pendingForkApplySeqRef.current !== applySeq
          ) {
            return
          }
          applyAll()
        })()

        return true
      }

      const screenReaderEnv =
        process.env.KODE_SCREEN_READER ?? process.env.SCREENREADER
      const canUseAltScreen =
        process.stdin.isTTY && process.stdout.isTTY && !screenReaderEnv

      const useEphemeralAltScreen =
        canUseAltScreen && getGlobalConfigCached().useAlternateBuffer !== true

      const doSetState = () => {
        toolViewStackRef.current = nextStack
        toolJSXRef.current = nextTop
        setToolViewStack(nextStack)
      }

      // When running in the main buffer (scrollback enabled), opening a fullscreen
      // TUI view leaves the entire screen in scrollback. To preserve scrollback
      // while keeping fullscreen dialogs clean, temporarily switch to the
      // terminal alternate screen for fullscreen tool views.
      if (useEphemeralAltScreen) {
        if (!prevFull && nextFull) {
          enterAlternateScreen()
          // Switching buffers can reset terminal modes (kitty/modifyOtherKeys/bracketed paste)
          // in some terminals; re-assert what we detected at startup so keybindings keep working.
          terminalCapabilityManager.enableSupportedModes()
          ephemeralFullscreenAltScreenRef.current = true
          void (async () => {
            await clearViewport()
            if (!isMountedRef.current) return
            doSetState()
          })()
          return
        } else if (prevFull && !nextFull) {
          if (ephemeralFullscreenAltScreenRef.current) {
            ephemeralFullscreenAltScreenRef.current = false
            exitAlternateScreen()
            terminalCapabilityManager.enableSupportedModes()
          }

          // Apply any pending transcript fork/reset immediately when leaving a
          // fullscreen tool view so the restored main buffer doesn't flash the
          // pre-overlay frame (e.g. `/resume`).
          if (maybeApplyPendingForkConvoWithMessages(doSetState)) return
        } else if (
          prevFull &&
          nextFull &&
          ephemeralFullscreenAltScreenRef.current
        ) {
          // Ensure clean transitions between fullscreen tool screens.
          doSetState()
          return
        }
      } else {
        if (prevFull !== nextFull) {
          // Avoid explicit terminal clears here; the UI should remain within the viewport
          // and rely on Ink's reconciliation to keep transitions stable.
          if (prevFull && !nextFull) {
            if (maybeApplyPendingForkConvoWithMessages(doSetState)) return
          }
          doSetState()
          return
        }
      }

      doSetState()
    },
    [setToolViewStack],
  )
  const setToolJSXWithClear = useCallback(
    (next: ToolView | null) => {
      setToolViewStackWithClear(next ? [next] : [])
    },
    [setToolViewStackWithClear],
  )
  const [pendingToolUseConfirms, setPendingToolUseConfirms] = useState<
    ToolUseConfirm[]
  >([])
  // The head of the queue is what the permission dialog renders. While the
  // engine runs concurrency-safe tools in parallel, multiple requests can
  // arrive at once; later ones are queued behind the head instead of
  // clobbering the single dialog slot.
  const toolUseConfirm = pendingToolUseConfirms[0] ?? null
  const setToolUseConfirm = useCallback(
    (confirm: ToolUseConfirm | null) => {
      setPendingToolUseConfirms(prev =>
        transitionToolUseConfirmQueue(prev, confirm),
      )
    },
    [],
  )
  const allowAllPendingToolUseConfirms = useCallback(() => {
    setPendingToolUseConfirms(prev => {
      for (const confirm of prev) {
        confirm.onAllow('temporary')
      }
      return []
    })
  }, [])
  const rejectAllPendingToolUseConfirms = useCallback(() => {
    setPendingToolUseConfirms(prev => {
      for (const confirm of prev) {
        confirm.onReject()
      }
      return []
    })
  }, [])
  const [messages, setMessages] = useState<MessageType[]>(
    props.initialMessages ?? [],
  )
  const [inputValue, setInputValue] = useState('')
  const [inputMode, setInputMode] = useState<PromptMode>('prompt')
  const [restorePastes, setRestorePastes] = useState<
    | {
        id: number
        pastedTexts: PastedTextSegment[]
        pastedImages: PastedImageAttachment[]
      }
    | undefined
  >(undefined)
  const [draftPastes, setDraftPastes] = useState<{
    pastedTexts: PastedTextSegment[]
    pastedImages: PastedImageAttachment[]
  }>({ pastedTexts: [], pastedImages: [] })
  const [sessionThinkingMode, setSessionThinkingMode] = useState<
    'auto' | 'enabled' | 'disabled' | null
  >(null)
  const [submitCount, setSubmitCount] = useState(0)
  const [isMessageSelectorVisible, setIsMessageSelectorVisible] =
    useState(false)
  const [showCostDialog, setShowCostDialog] = useState(false)
  const [haveShownCostDialog, setHaveShownCostDialog] = useState(
    getGlobalConfigCached().hasAcknowledgedCostThreshold,
  )
  const [binaryFeedbackContext, setBinaryFeedbackContext] =
    useState<BinaryFeedbackContext | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const toastTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showToast = useCallback((text: string) => {
    setToast(text)
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current)
    }
    toastTimeoutRef.current = setTimeout(() => setToast(null), 6000)
  }, [])

  const dismissToolView = useCallback(() => {
    const current = toolViewStackRef.current
    if (current.length === 0) return
    setToolViewStackWithClear(current.slice(0, -1))
  }, [setToolViewStackWithClear])

  const openToolView = useCallback(
    (view: NonNullable<typeof toolJSX>) => {
      setToolViewStackWithClear([...toolViewStackRef.current, view])
    },
    [setToolViewStackWithClear],
  )

  const openTasksScreen = useCallback(async () => {
    const { TasksScreen } = await import('#ui-ink/screens/overlays/TasksScreen')
    openToolView({
      jsx: <TasksScreen onDone={dismissToolView} />,
      shouldHidePromptInput: true,
      displayMode: 'fullscreen',
    })
  }, [dismissToolView, openToolView])

  const openWorkTasksScreen = useCallback(async () => {
    const { WorkTasksScreen } = await import(
      '#ui-ink/screens/overlays/WorkTasksScreen'
    )
    openToolView({
      jsx: <WorkTasksScreen onDone={dismissToolView} />,
      shouldHidePromptInput: true,
      displayMode: 'fullscreen',
    })
  }, [dismissToolView, openToolView])

  type ReplOnQueryFn = (
    newMessages: MessageType[],
    passedAbortController?: AbortController,
  ) => Promise<void>

  const apiKeyStatusRef = useRef<VerificationStatus>('loading')
  const onQueryRef = useRef<ReplOnQueryFn | null>(null)
  const onQueryRefWithRuntimeGate = useCallback(
    async (
      newMessages: MessageType[],
      passedAbortController?: AbortController,
    ) => {
      await runtimeReadyRef.current
      await onQueryRef.current?.(newMessages, passedAbortController)
    },
    [],
  )
  const scheduleDispatchingRef = useRef(false)
  const dispatchedUnstartedGoalRunIdsRef = useRef(new Set<string>())

  const openHistorySearchScreen = useCallback(async () => {
    const { HistorySearchScreen } = await import(
      '#ui-ink/screens/overlays/HistorySearchScreen'
    )
    openToolView({
      jsx: (
        <HistorySearchScreen
          onDone={result => {
            dismissToolView()

            if (result.action === 'cancel') return

            const selected = result.value
            const pastedTexts = result.pastedTexts
            const { mode, text } = parsePromptHistoryDisplay(selected)

            if (result.action === 'accept') {
              setInputMode(mode)
              setInputValue(text)
              setRestorePastes({
                id: Date.now(),
                pastedTexts,
                pastedImages: [],
              })
              return
            }

            if (isLoading || apiKeyStatusRef.current !== 'valid') {
              setInputMode(mode)
              setInputValue(text)
              setRestorePastes({
                id: Date.now(),
                pastedTexts,
                pastedImages: [],
              })
              return
            }

            void (async () => {
              const conversationKey = `${props.messageLogName}:${forkNumber}`
              const toolPermissionContext =
                getToolPermissionContextForConversationKey({
                  conversationKey,
                  isBypassPermissionsModeAvailable: !safeMode,
                })

              const exit = () => requestCliExit(0)

              await submitPrompt({
                input: text,
                mode,
                isDisabled: apiKeyStatusRef.current !== 'valid',
                isLoading: false,
                isEditingExternally: false,
                abortController,
                setIsLoading,
                setAbortController,
                onInputChange: setInputValue,
                onModeChange: setInputMode,
                setCursorOffset: () => {},
                onSubmitCountChange: setSubmitCount,
                onQuery: onQueryRefWithRuntimeGate,
                setToolJSX: setToolJSXWithClear,
                commands,
                forkNumber,
                messageLogName: props.messageLogName,
                tools,
                verbose,
                disableSlashCommands,
                permissionMode: toolPermissionContext.mode,
                toolPermissionContext,
                setForkConvoWithMessagesOnTheNextRender,
                readFileTimestamps: readFileTimestampsRef.current,
                pastedTexts,
                pastedImages: [],
                clearPastes: () => {},
                resetHistory: () => {},
                setCurrentPwd: () => {},
                exit,
              })
            })()
          }}
        />
      ),
      shouldHidePromptInput: true,
      displayMode: 'fullscreen',
    })
  }, [
    abortController,
    commands,
    disableSlashCommands,
    dismissToolView,
    forkNumber,
    isLoading,
    onQueryRefWithRuntimeGate,
    openToolView,
    props.messageLogName,
    tools,
    safeMode,
    setAbortController,
    setForkConvoWithMessagesOnTheNextRender,
    setIsLoading,
    setToolJSXWithClear,
    verbose,
  ])

  useKeypress(
    async (inputChar, key) => {
      const hasModal =
        Boolean(toolJSX) ||
        Boolean(toolUseConfirm) ||
        Boolean(binaryFeedbackContext) ||
        showingCostDialog ||
        isMessageSelectorVisible

      if (key.ctrl && inputChar === 'c' && isLoading) {
        setToolJSXWithClear(null)
        setToolUseConfirm(null)
        setBinaryFeedbackContext(null)
        onCancel()
        return undefined
      }

      if (hasModal) return undefined

      if (key.ctrl && inputChar === 't') {
        void openWorkTasksScreen()
        return undefined
      }

      if (key.ctrl && inputChar === 'o') {
        const { TranscriptScreen } = await import(
          '#ui-ink/screens/overlays/TranscriptScreen'
        )
        openToolView({
          jsx: (
            <TranscriptScreen
              onDone={dismissToolView}
              label={`${props.messageLogName}-${forkNumber}`}
              initialFollow={true}
            />
          ),
          shouldHidePromptInput: true,
          displayMode: 'fullscreen',
        })
        return undefined
      }

      if (key.ctrl && inputChar === 'r') {
        void openHistorySearchScreen()
        return undefined
      }

      if (key.meta && inputChar === 't') {
        const effectiveThinkingMode =
          sessionThinkingMode ?? getGlobalConfigCached().thinkingMode ?? 'auto'
        const isMidConversation =
          messages.some(m => m.type === 'assistant') ||
          messages.some(m => m.type === 'user' && !(m as any)?.isMeta)

        const { ThinkingToggleScreen, getThinkingModeLabel } = await import(
          '#ui-ink/screens/overlays/ThinkingToggleScreen'
        )
        openToolView({
          jsx: (
            <ThinkingToggleScreen
              currentMode={effectiveThinkingMode}
              isMidConversation={isMidConversation}
              onSelect={mode => {
                setSessionThinkingMode(mode)
                showToast(`Thinking: ${getThinkingModeLabel(mode)}`)
              }}
              onDone={dismissToolView}
            />
          ),
          shouldHidePromptInput: true,
          displayMode: 'fullscreen',
        })
        return undefined
      }

      if (key.meta && inputChar === 'p') {
        const { ModelPickerScreen } = await import(
          '#ui-ink/screens/overlays/ModelPickerScreen'
        )
        openToolView({
          jsx: (
            <ModelPickerScreen
              onDone={dismissToolView}
              onSelectModel={modelName => {
                const modelManager = getModelManager()
                const selectedModel = modelManager
                  .getAvailableModels()
                  .find(model => model.modelName === modelName)
                modelManager.setPointer('main', modelName)
                triggerModelConfigChange()
                showToast(`Model: ${selectedModel?.name ?? modelName}`)
              }}
              onOpenModelConfig={() => {
                void import('#ui-ink/components/ModelConfig').then(
                  ({ ModelConfig }) => {
                    setToolViewStackWithClear([
                      ...toolViewStackRef.current.slice(0, -1),
                      {
                        jsx: (
                          <ModelConfig
                            onClose={() => {
                              import('#core/utils/model').then(
                                ({ reloadModelManager }) => {
                                  reloadModelManager()
                                  triggerModelConfigChange()
                                  showToast('Model settings updated')
                                  dismissToolView()
                                },
                              )
                            }}
                          />
                        ),
                        shouldHidePromptInput: true,
                        displayMode: 'fullscreen',
                      },
                    ])
                  },
                )
              }}
            />
          ),
          shouldHidePromptInput: true,
          displayMode: 'fullscreen',
        })
        return undefined
      }

      if (inputChar === '?' && inputValue.trim().length === 0) {
        const { ShortcutsScreen } = await import(
          '#ui-ink/screens/overlays/ShortcutsScreen'
        )
        openToolView({
          jsx: <ShortcutsScreen onDone={dismissToolView} />,
          shouldHidePromptInput: true,
          displayMode: 'fullscreen',
        })
        return undefined
      }

      if (key.name === 'f1') {
        const { HelpScreen } = await import(
          '#ui-ink/screens/overlays/HelpScreen'
        )
        openToolView({
          jsx: <HelpScreen commands={commands} onDone={dismissToolView} />,
          shouldHidePromptInput: true,
          displayMode: 'fullscreen',
        })
        return undefined
      }

      if (key.name === 'f2') {
        const { ConfigScreen } = await import(
          '#ui-ink/screens/overlays/ConfigScreen'
        )
        openToolView({
          jsx: <ConfigScreen onClose={dismissToolView} />,
          shouldHidePromptInput: true,
          displayMode: 'fullscreen',
        })
        return undefined
      }

      if (key.name === 'f3') {
        const { OpenFileScreen } = await import(
          '#ui-ink/screens/overlays/OpenFileScreen'
        )
        openToolView({
          jsx: <OpenFileScreen onDone={dismissToolView} />,
          shouldHidePromptInput: true,
          displayMode: 'fullscreen',
        })
        return undefined
      }

      if (key.name === 'f4') {
        const { ConsoleScreen } = await import(
          '#ui-ink/screens/overlays/ConsoleScreen'
        )
        openToolView({
          jsx: <ConsoleScreen onDone={dismissToolView} />,
          shouldHidePromptInput: true,
          displayMode: 'fullscreen',
        })
        return undefined
      }

      if (key.name === 'f5') {
        const { NotificationsScreen } = await import(
          '#ui-ink/screens/overlays/NotificationsScreen'
        )
        openToolView({
          jsx: <NotificationsScreen onDone={dismissToolView} />,
          shouldHidePromptInput: true,
          displayMode: 'fullscreen',
        })
        return undefined
      }

      if (key.name === 'f6') {
        const { TranscriptScreen } = await import(
          '#ui-ink/screens/overlays/TranscriptScreen'
        )
        openToolView({
          jsx: (
            <TranscriptScreen
              onDone={dismissToolView}
              label={`${props.messageLogName}-${forkNumber}`}
            />
          ),
          shouldHidePromptInput: true,
          displayMode: 'fullscreen',
        })
        return undefined
      }

      if (key.name === 'f8') {
        void openTasksScreen()
        return undefined
      }

      // F10 is intentionally a discrete toggle: terminal input provides
      // keypress sequences but not a portable key-up event, so push-to-talk
      // would stop unpredictably across terminals.
      if (key.name === 'f10' && isExperimentalVoiceEnabled()) {
        const { VoiceScreen } =
          await import('#ui-ink/screens/overlays/VoiceScreen')
        openToolView({
          jsx: <VoiceScreen onDone={dismissToolView} />,
          shouldHidePromptInput: true,
          displayMode: 'fullscreen',
        })
        return undefined
      }

      if (key.name === 'f7') {
        const { CommandPaletteScreen } = await import(
          '#ui-ink/screens/overlays/CommandPaletteScreen'
        )
        openToolView({
          jsx: (
            <CommandPaletteScreen
              commands={commands}
              onDone={async action => {
                if (!action) {
                  dismissToolView()
                  return
                }

                if (typeof action !== 'string') {
                  setInputMode('prompt')
                  setInputValue(`/${action.name} `)
                  showToast(
                    action.argumentHint
                      ? `Command ready: /${action.name} ${action.argumentHint}`
                      : `Command ready: /${action.name}`,
                  )
                  dismissToolView()
                  return
                }

                if (action === 'help') {
                  const { HelpScreen } = await import(
                    '#ui-ink/screens/overlays/HelpScreen'
                  )
                  openToolView({
                    jsx: (
                      <HelpScreen
                        commands={commands}
                        onDone={dismissToolView}
                      />
                    ),
                    shouldHidePromptInput: true,
                    displayMode: 'fullscreen',
                  })
                  return
                }

                if (action === 'config') {
                  const { ConfigScreen } = await import(
                    '#ui-ink/screens/overlays/ConfigScreen'
                  )
                  openToolView({
                    jsx: <ConfigScreen onClose={dismissToolView} />,
                    shouldHidePromptInput: true,
                    displayMode: 'fullscreen',
                  })
                  return
                }

                if (action === 'open') {
                  const { OpenFileScreen } = await import(
                    '#ui-ink/screens/overlays/OpenFileScreen'
                  )
                  openToolView({
                    jsx: <OpenFileScreen onDone={dismissToolView} />,
                    shouldHidePromptInput: true,
                    displayMode: 'fullscreen',
                  })
                  return
                }

                if (action === 'console') {
                  const { ConsoleScreen } = await import(
                    '#ui-ink/screens/overlays/ConsoleScreen'
                  )
                  openToolView({
                    jsx: <ConsoleScreen onDone={dismissToolView} />,
                    shouldHidePromptInput: true,
                    displayMode: 'fullscreen',
                  })
                  return
                }

                if (action === 'notifications') {
                  const { NotificationsScreen } = await import(
                    '#ui-ink/screens/overlays/NotificationsScreen'
                  )
                  openToolView({
                    jsx: <NotificationsScreen onDone={dismissToolView} />,
                    shouldHidePromptInput: true,
                    displayMode: 'fullscreen',
                  })
                  return
                }

                if (action === 'transcript') {
                  const { TranscriptScreen } = await import(
                    '#ui-ink/screens/overlays/TranscriptScreen'
                  )
                  openToolView({
                    jsx: (
                      <TranscriptScreen
                        onDone={dismissToolView}
                        label={`${props.messageLogName}-${forkNumber}`}
                      />
                    ),
                    shouldHidePromptInput: true,
                    displayMode: 'fullscreen',
                  })
                  return
                }

                if (action === 'doctor') {
                  const { Doctor } = await import('#ui-ink/screens/Doctor')
                  openToolView({
                    jsx: (
                      <Doctor onDone={dismissToolView} doctorMode={true} />
                    ),
                    shouldHidePromptInput: true,
                    displayMode: 'fullscreen',
                  })
                  return
                }

                if (action === 'model') {
                  try {
                    abortController?.abort?.()
                  } catch {
                    // Continue opening model settings if cancellation raced.
                  }
                  setIsLoading(false)

                  const { ModelConfig } = await import(
                    '#ui-ink/components/ModelConfig'
                  )
                  openToolView({
                    jsx: (
                      <ModelConfig
                        onClose={() => {
                          import('#core/utils/model').then(
                            ({ reloadModelManager }) => {
                              reloadModelManager()
                              triggerModelConfigChange()
                              dismissToolView()
                            },
                          )
                        }}
                      />
                    ),
                    shouldHidePromptInput: true,
                    displayMode: 'fullscreen',
                  })
                  return
                }

                dismissToolView()
              }}
            />
          ),
          shouldHidePromptInput: true,
          displayMode: 'fullscreen',
        })
        return undefined
      }

      return undefined
    },
    { priority: KEYPRESS_PRIORITY.REPL_CONTROLLER },
  )

  const getBinaryFeedbackResponse = useCallback(
    (m1: BinaryFeedbackContext['m1'], m2: BinaryFeedbackContext['m2']) => {
      return new Promise<BinaryFeedbackResult>(resolvePromise => {
        setBinaryFeedbackContext({ m1, m2, resolve: resolvePromise })
      })
    },
    [],
  )

  const readFileTimestampsRef = useRef<{ [filename: string]: number }>({})

  const { status: apiKeyStatus, reverify } = useApiKeyVerification()
  useEffect(() => {
    apiKeyStatusRef.current = apiKeyStatus
  }, [apiKeyStatus])

  useEffect(() => {
    // Best-effort eager init so the first LSP tool call doesn't pay process startup latency.
    void ensureLspManagerInitialized().catch(() => {})
  }, [])

  useEffect(() => {
    // Start after the first TUI render. This is process-wide, does no provider
    // I/O, and shares one promise with an immediately submitted first request.
    void prewarmLlmRuntime().catch(() => {})
  }, [])

  const onCancel = useCallback(() => {
    if (!isLoadingRef.current) return
    const activeAbortController = abortControllerRef.current
    setCancelRequestKey(prev => prev + 1)
    setIsLoading(false)
    if (activeAbortController) {
      assistantStreamStore.endTurn(activeAbortController)
    }
    if (toolUseConfirm) {
      toolUseConfirm.onAbort()
      setAbortController(null)
      showToast('Interrupted')
      return
    }
    if (activeAbortController && !activeAbortController.signal.aborted) {
      activeAbortController.abort()
    }
    setAbortController(null)
    showToast('Interrupted')
  }, [
    assistantStreamStore,
    setAbortController,
    setIsLoading,
    showToast,
    toolUseConfirm,
  ])

  const getIsLoading = useCallback(() => isLoadingRef.current, [])
  const getAbortSignal = useCallback(
    () => abortControllerRef.current?.signal,
    [],
  )

  useCancelRequest(
    setToolJSXWithClear,
    setToolUseConfirm,
    setBinaryFeedbackContext,
    onCancel,
    getIsLoading,
    isMessageSelectorVisible,
    getAbortSignal,
  )

  useEffect(() => {
    if (!pendingForkConvoWithMessages) return

    // If a fullscreen tool view is still mounted, we may still be on the
    // alternate screen buffer (ephemeral fullscreen mode). Wait until the view
    // is dismissed so clears apply to the active REPL buffer.
    if (toolJSX?.displayMode === 'fullscreen') return

    const request = pendingForkConvoWithMessages
    const applySeq = ++pendingForkApplySeqRef.current
    setPendingForkConvoWithMessages(null)
    pendingForkConvoWithMessagesRef.current = null

    // Keep viewport clears ordered before the React state replacement. Otherwise
    // resize/reflow can interleave with a full transcript replacement and leave
    // duplicate footer/header frames in scrollback.
    const applyStateUpdates = () => {
      setForkNumber(prev => prev + 1)
      setStaticOutputEpoch(prev => prev + 1)
      setMessages(request.messages)

      if (request.options?.resetInput) {
        setInputMode('prompt')
        setInputValue('')
        setRestorePastes(undefined)
        setDraftPastes({ pastedTexts: [], pastedImages: [] })
      }
    }

    void (async () => {
      if (request.options?.clearViewport) {
        await clearViewport()
      }

      if (
        !isMountedRef.current ||
        pendingForkApplySeqRef.current !== applySeq
      ) {
        return
      }

      if (batchedUpdates) {
        batchedUpdates(applyStateUpdates)
      } else {
        applyStateUpdates()
      }
    })()
  }, [pendingForkConvoWithMessages, toolJSX?.displayMode])

  useEffect(() => {
    const totalCost = getTotalCost()
    if (totalCost >= 5 && !showCostDialog && !haveShownCostDialog) {
      setShowCostDialog(true)
    }
  }, [messages, showCostDialog, haveShownCostDialog])

  const ultrathinkToastActiveRef = useRef(false)
  useEffect(() => {
    if (inputMode === 'bash' || inputMode === 'background') {
      ultrathinkToastActiveRef.current = false
      return
    }

    const hasUltrathink = /\bultrathink\b/i.test(inputValue)
    const effectiveThinkingMode =
      sessionThinkingMode ?? getGlobalConfigCached().thinkingMode ?? 'auto'

    if (
      hasUltrathink &&
      !ultrathinkToastActiveRef.current &&
      effectiveThinkingMode === 'auto'
    ) {
      showToast('Thinking on')
    }

    ultrathinkToastActiveRef.current = hasUltrathink
  }, [inputMode, inputValue, sessionThinkingMode, showToast])

  useEffect(() => {
    return subscribeAgentReloads(event => {
      const count = event.changedPaths.length
      showToast(
        count > 0
          ? `Agents reloaded (${count} file${count === 1 ? '' : 's'})`
          : 'Agents reloaded',
      )
    })
  }, [showToast])

  useEffect(() => {
    let cancelled = false
    const unsubscribe = subscribeCustomCommandReloads(event => {
      const count = event.changedPaths.length
      showToast(
        count > 0
          ? `Commands reloaded (${count} change${count === 1 ? '' : 's'})`
          : 'Commands reloaded',
      )

      void (async () => {
        try {
          const { getCommands } = await import('#cli-commands')
          const next = await getCommands()
          if (cancelled) return
          setCommands(next)
          setUiRefreshCounter(prev => prev + 1)
        } catch (error) {
          logError(error)
        }
      })()
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [showToast])

  useEffect(() => {
    return () => {
      if (toastTimeoutRef.current) {
        clearTimeout(toastTimeoutRef.current)
        toastTimeoutRef.current = null
      }
    }
  }, [])

  const canUseTool = useCanUseTool(
    confirm => setToolUseConfirm(confirm),
    {
    onPermissionRuleWarnings: warnings => {
      const first = warnings[0]
      const example = first
        ? `${first.rule} (${describeToolPermissionRuleSource(first.source)})`
        : ''
      const fix = first?.fix ? ` Fix: ${first.fix}` : ''
      showToast(
        `Permission rules: ${warnings.length} unreachable rule${
          warnings.length === 1 ? '' : 's'
        } detected${example ? ` (e.g. ${example})` : ''}.${fix}`,
      )
    },
  })
  const requestToolUsePermission = useRequestToolUsePermission({
    setToolUseConfirm,
  })

  const onQuery = useReplQuery({
    disableSlashCommands,
    systemPromptOverride: props.systemPromptOverride,
    appendSystemPrompt: props.appendSystemPrompt,
    messages,
    setMessages,
    commands,
    forkNumber,
    messageLogName: props.messageLogName,
    thinkingMode:
      sessionThinkingMode ?? getGlobalConfigCached().thinkingMode ?? 'auto',
    tools,
    mcpClients,
    verbose,
    safeMode,
    checkPendingForkAndSuppressAppend,
    requestToolUsePermission,
    canUseTool,
    readFileTimestamps: readFileTimestampsRef.current,
    setToolJSX: setToolJSXWithClear,
    getBinaryFeedbackResponse,
    setAbortController,
    clearAbortController,
    setIsLoading,
    assistantStreamStore,
  })
  useEffect(() => {
    onQueryRef.current = onQuery
  }, [onQuery])

  // A durable /loop wakes only when this interactive session is genuinely
  // idle. The schedule is atomically claimed before it becomes an ordinary
  // REPL turn, so a restart cannot replay missed intervals or double-run it.
  useEffect(() => {
    if (process.env.NODE_ENV === 'test') return undefined

    let disposed = false
    const tick = () => {
      if (
        disposed ||
        scheduleDispatchingRef.current ||
        isLoading ||
        apiKeyStatusRef.current !== 'valid' ||
        toolJSX ||
        toolUseConfirm ||
        binaryFeedbackContext ||
        isMessageSelectorVisible ||
        inputValue.trim().length > 0
      ) {
        return
      }

      let schedule: ClaimedSchedule | undefined
      let isUnstartedGoalRun = false
      try {
        const cwd = getCwd()
        const sessionId = getKodeAgentSessionId()
        schedule = claimDueSchedules({
          cwd,
          sessionId,
          limit: 1,
        })[0]
        if (!schedule) {
          schedule =
            getUnstartedGoalRunSchedule(
              new GoalService().findActiveGoal({ cwd, sessionId }),
            ) ?? undefined
          isUnstartedGoalRun = schedule !== undefined
        }
      } catch (error) {
        logError(error)
        return
      }
      if (!schedule) return
      if (
        isUnstartedGoalRun &&
        dispatchedUnstartedGoalRunIdsRef.current.has(schedule.runId)
      ) {
        return
      }

      scheduleDispatchingRef.current = true
      if (isUnstartedGoalRun) {
        dispatchedUnstartedGoalRunIdsRef.current.add(schedule.runId)
      }
      setIsLoading(true)
      showToast(
        `${schedule.kind === 'interval' ? 'Scheduled loop' : 'Goal run'}: ${schedule.prompt}`,
      )
      void onQueryRefWithRuntimeGate([createUserMessage(schedule.prompt)])
        .catch(error => logError(error))
        .finally(() => {
          scheduleDispatchingRef.current = false
        })
    }

    const timer = setInterval(tick, 1_000)
    timer.unref?.()
    tick()
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [
    binaryFeedbackContext,
    inputValue,
    isLoading,
    isMessageSelectorVisible,
    onQueryRefWithRuntimeGate,
    setIsLoading,
    showToast,
    toolJSX,
    toolUseConfirm,
  ])

  const onInit = useReplInit({
    initialPrompt: props.initialPrompt,
    commands,
    forkNumber,
    messageLogName: props.messageLogName,
    tools,
    mcpClients,
    verbose,
    safeMode,
    messages,
    setToolJSX: setToolJSXWithClear,
    readFileTimestamps: readFileTimestampsRef.current,
    setForkConvoWithMessagesOnTheNextRender,
    reverify,
    setIsLoading,
    setAbortController,
    clearAbortController,
    setHaveShownCostDialog,
    onQuery: onQueryRefWithRuntimeGate,
  })
  const onInitRef = useRef(onInit)
  onInitRef.current = onInit

  useCostSummary()

  const setMessagesFromExternalStore = useCallback<MessageStateSetter>(
    (update, options) => {
      if (options?.preserveTranscript) {
        setMessages(previous => {
          const next = typeof update === 'function' ? update(previous) : update
          const previousMessageIds = new Set(
            previous.map(message => message.uuid),
          )
          const introducedMessages = next.filter(
            message => !previousMessageIds.has(message.uuid),
          )

          // Compaction creates summary/recovery messages with new UUIDs. They
          // belong to model context, not the existing terminal scrollback.
          // Existing messages stay eligible so an unprinted live message is
          // never hidden by a context-only rewrite.
          for (const message of normalizeMessages(introducedMessages)) {
            suppressedTranscriptMessageIdsRef.current.add(message.uuid)
          }
          return next
        })
        return
      }

      if (typeof update !== 'function') {
        setStaticOutputEpoch(prev => prev + 1)
      }
      setMessages(update)
    },
    [],
  )

  useEffect(() => {
    setMessagesGetter(() => messages)
    setMessagesSetter(setMessagesFromExternalStore)
  }, [messages, setMessagesFromExternalStore])

  useEffect(() => {
    setModelConfigChangeHandler(() => setUiRefreshCounter(prev => prev + 1))
  }, [])

  useLogMessages(messages, props.messageLogName, forkNumber)
  useLogStartupTime()

  useEffect(() => {
    let cancelled = false
    void runtimeReadyRef.current.then(() => {
      if (cancelled) return
      onInitRef.current()
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const transcript = useTranscriptItems({
    messages,
    tools,
    verbose,
    debug,
    toolJSX,
    toolUseConfirm,
    isMessageSelectorVisible,
    forkNumber,
    // Bottom-anchored frame only makes sense when the terminal has room for
    // transcript content; tiny viewports keep everything in <Static>.
    keepRecentInFrame: terminalRows > 4,
  })

  const startupHeaderKey = useMemo(
    () =>
      buildStartupHeaderIdentityKey({
        forkNumber,
        isDefaultModel,
        updateAvailableVersion,
        updateCommands,
        mcpClients,
      }),
    [
      forkNumber,
      isDefaultModel,
      mcpClients,
      updateAvailableVersion,
      updateCommands,
    ],
  )

  const startupHeader = useMemo(
    () => (
      <Box flexDirection="column" key={startupHeaderKey}>
        <Logo
          mcpClients={mcpClients}
          isDefaultModel={isDefaultModel}
          updateBannerVersion={updateAvailableVersion}
          updateBannerCommands={updateCommands}
          terminalColumns={terminalColumns}
          terminalRows={terminalRows}
        />
        <ProjectOnboarding workspaceDir={getOriginalCwd()} />
      </Box>
    ),
    [
      isDefaultModel,
      mcpClients,
      startupHeaderKey,
      terminalColumns,
      terminalRows,
      updateAvailableVersion,
      updateCommands,
    ],
  )
  const showStartupHeader =
    messages.length === 0 && transcript.items.length === 0

  const staticItemsRef = useRef<TranscriptItem[]>([])
  const printedKeysRef = useRef<Set<string>>(new Set())
  const lastStaticOutputEpochRef = useRef<number>(staticOutputEpoch)

  const staticItems = useMemo(() => {
    if (lastStaticOutputEpochRef.current !== staticOutputEpoch) {
      lastStaticOutputEpochRef.current = staticOutputEpoch
      staticItemsRef.current = []
      printedKeysRef.current = new Set()
      suppressedTranscriptMessageIdsRef.current.clear()
    }

    const activeMessageIds = new Set<string>(
      transcript.orderedMessages.map(message => message.uuid),
    )
    for (const messageId of suppressedTranscriptMessageIdsRef.current) {
      if (!activeMessageIds.has(messageId)) {
        suppressedTranscriptMessageIdsRef.current.delete(messageId)
      }
    }

    const items: TranscriptItem[] = []

    items.push(
      ...transcript.items
        .slice(0, transcript.replStaticPrefixLength)
        .filter(
          item =>
            !isSuppressedTranscriptItem(
              item,
              suppressedTranscriptMessageIdsRef.current,
            ),
        ),
    )

    // Only add items that haven't been printed yet
    const newItems: TranscriptItem[] = []
    for (const item of items) {
      if (!printedKeysRef.current.has(item.key)) {
        printedKeysRef.current.add(item.key)
        newItems.push(item)
      }
    }

    // Append new items to the stable array
    if (newItems.length > 0) {
      staticItemsRef.current = [...staticItemsRef.current, ...newItems]
    }

    return staticItemsRef.current
  }, [
    staticOutputEpoch,
    transcript.items,
    transcript.orderedMessages,
    transcript.replStaticPrefixLength,
  ])

  const transientItems = useMemo(
    () =>
      transcript.items
        .slice(transcript.replStaticPrefixLength)
        .filter(
          item =>
            !isSuppressedTranscriptItem(
              item,
              suppressedTranscriptMessageIdsRef.current,
            ),
        ),
    [transcript.items, transcript.replStaticPrefixLength],
  )

  const showingCostDialog = !isLoading && showCostDialog
  const conversationKey = `${props.messageLogName}:${forkNumber}`

  const onCostDialogDone = useCallback(() => {
    setShowCostDialog(false)
    setHaveShownCostDialog(true)
    const projectConfig = getGlobalConfigCached()
    saveGlobalConfig({ ...projectConfig, hasAcknowledgedCostThreshold: true })
  }, [])

  const handleShowMessageSelector = useCallback(() => {
    setIsMessageSelectorVisible(prev => !prev)
  }, [])

  const handleRestorePastesApplied = useCallback((id: number) => {
    setRestorePastes(prev => {
      if (!prev) return prev
      if (prev.id !== id) return prev
      return undefined
    })
  }, [])

  const promptInputProps = useMemo(
    () =>
      buildPromptInputProps({
        commands,
        forkNumber,
        messageLogName: props.messageLogName,
        initialPrompt: props.initialPrompt,
        tools,
        disableSlashCommands,
        isDisabled: apiKeyStatus !== 'valid',
        isLoading,
        onQuery: onQueryRefWithRuntimeGate,
        debug,
        verbose,
        messages,
        setToolJSX: setToolJSXWithClear,
        input: inputValue,
        onInputChange: setInputValue,
        mode: inputMode,
        onModeChange: setInputMode,
        submitCount,
        onSubmitCountChange: setSubmitCount,
        setIsLoading,
        setAbortController,
        cancelRequestKey,
        uiRefreshCounter,
        onShowMessageSelector: handleShowMessageSelector,
        setForkConvoWithMessagesOnTheNextRender,
        readFileTimestamps: readFileTimestampsRef.current,
        abortController,
        restorePastes,
        onRestorePastesApplied: handleRestorePastesApplied,
        draftPastes,
        onDraftPastesChange: setDraftPastes,
      }),
    [
      abortController,
      apiKeyStatus,
      cancelRequestKey,
      commands,
      debug,
      disableSlashCommands,
      draftPastes,
      forkNumber,
      handleRestorePastesApplied,
      handleShowMessageSelector,
      inputMode,
      inputValue,
      isLoading,
      messages,
      onQueryRefWithRuntimeGate,
      props.initialPrompt,
      props.messageLogName,
      tools,
      restorePastes,
      setAbortController,
      setForkConvoWithMessagesOnTheNextRender,
      setIsLoading,
      setToolJSXWithClear,
      submitCount,
      uiRefreshCounter,
      verbose,
    ],
  )

  const handleMessageSelectorSelect = useMessageSelectorSelect({
    messages,
    setIsMessageSelectorVisible,
    setForkConvoWithMessagesOnTheNextRender,
    setInputValue,
    onCancel,
  })

  return {
    conversationKey,
    safeMode,
    debug,
    staticOutputEpoch,
    staticItems,
    startupHeader,
    startupHeaderKey,
    showStartupHeader,
    transientItems,
    assistantStreamStore,
    toolJSX,
    toolUseConfirm,
    setToolUseConfirm,
    pendingToolUseConfirmCount: pendingToolUseConfirms.length,
    allowAllPendingToolUseConfirms,
    rejectAllPendingToolUseConfirms,
    toast,
    binaryFeedbackContext,
    setBinaryFeedbackContext,
    isLoading,
    verbose,
    normalizedMessages: transcript.normalizedMessages,
    tools,
    erroredToolUseIDs: transcript.erroredToolUseIDs,
    inProgressToolUseIDs: transcript.inProgressToolUseIDs,
    unresolvedToolUseIDs: transcript.unresolvedToolUseIDs,
    showingCostDialog,
    onCostDialogDone,
    shouldShowPromptInput: props.shouldShowPromptInput,
    isMessageSelectorVisible,
    promptInputProps,
    messageSelectorMessages: messages,
    onMessageSelectorSelect: handleMessageSelectorSelect,
    onMessageSelectorEscape: () => setIsMessageSelectorVisible(false),
  }
}
