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
} from '#core/messages'
import type { Message as MessageType } from '#core/query'
import { getGlobalConfigCached, saveGlobalConfig } from '#core/utils/config'
import { getNextAvailableLogForkNumber, logError } from '#core/utils/log'
import { getOriginalCwd } from '#core/utils/state'
import { MACRO } from '#core/constants/macros'
import { subscribeAgentReloads } from '#core/agent/events'
import { subscribeCustomCommandReloads } from '#cli-services/customCommands'
import {
  setMcpElicitationPresenter,
  type McpElicitationPrompt,
} from '#cli-services/mcpCapabilities'
import { HelpScreen } from '#ui-ink/screens/overlays/HelpScreen'
import { ShortcutsScreen } from '#ui-ink/screens/overlays/ShortcutsScreen'
import { ConfigScreen } from '#ui-ink/screens/overlays/ConfigScreen'
import { OpenFileScreen } from '#ui-ink/screens/overlays/OpenFileScreen'
import { ConsoleScreen } from '#ui-ink/screens/overlays/ConsoleScreen'
import { NotificationsScreen } from '#ui-ink/screens/overlays/NotificationsScreen'
import { TranscriptScreen } from '#ui-ink/screens/overlays/TranscriptScreen'
import { CommandPaletteScreen } from '#ui-ink/screens/overlays/CommandPaletteScreen'
import { TasksScreen } from '#ui-ink/screens/overlays/TasksScreen'
import { WorkTasksScreen } from '#ui-ink/screens/overlays/WorkTasksScreen'
import { HistorySearchScreen } from '#ui-ink/screens/overlays/HistorySearchScreen'
import { ModelPickerScreen } from '#ui-ink/screens/overlays/ModelPickerScreen'
import { ThinkingToggleScreen } from '#ui-ink/screens/overlays/ThinkingToggleScreen'
import { ModelConfig } from '#ui-ink/components/ModelConfig'
import { Doctor } from '#ui-ink/screens/Doctor'
import { useKeypress } from '#ui-ink/hooks/useKeypress'
import { submitPrompt } from '#ui-ink/components/PromptInput/submit'
import { useTranscriptItems, type TranscriptItem } from './useTranscriptItems'
import { useRequestToolUsePermission } from './useRequestToolUsePermission'
import { useReplQuery } from './useReplQuery'
import { useReplInit } from './useReplInit'
import { buildPromptInputProps } from './promptInputProps'
import { useMessageSelectorSelect } from './useMessageSelectorSelect'
import type { BinaryFeedbackContext, REPLProps } from './types'
import { ensureLspManagerInitialized } from '#tools/tools/system/LspTool/call'
import { describeToolPermissionRuleSource } from '#core/permissions/ruleString'
import { triggerModelConfigChange } from '#core/messages'
import {
  clearViewport,
  enterAlternateScreen,
  exitAlternateScreen,
} from '#cli-utils/terminal'
import { getModelManager } from '#core/utils/model'
import { getToolPermissionContextForConversationKey } from '#core/utils/toolPermissionContextState'
import type { PromptMode } from '#ui-ink/components/PromptInput/types'
import { KEYPRESS_PRIORITY } from '#ui-ink/constants/keypressPriority'
import { terminalCapabilityManager } from '#ui-ink/utils/terminalCapabilityManager'
import type {
  ForkConvoWithMessagesOptions,
  SetForkConvoWithMessagesOnTheNextRender,
} from '#ui-ink/types/conversationReset'

const batchedUpdates: ((fn: () => void) => void) | null =
  typeof (ReactReconciler as any)?.batchedUpdates === 'function'
    ? ((ReactReconciler as any).batchedUpdates as (fn: () => void) => void)
    : typeof (ReactReconciler as any)?.default?.batchedUpdates === 'function'
      ? ((ReactReconciler as any).default.batchedUpdates as (
          fn: () => void,
        ) => void)
      : null

export function useReplController(props: REPLProps) {
  const debug = props.debug ?? false
  const disableSlashCommands = props.disableSlashCommands ?? false
  const safeMode = Boolean(props.safeMode)
  const mcpClients = props.mcpClients ?? []
  const isDefaultModel = props.isDefaultModel ?? true
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

  useEffect(() => {
    if (process.env.NODE_ENV === 'test') return
    if (updateAvailableVersion || updateCommands) return

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

  const [abortController, setAbortController] =
    useState<AbortController | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  type ToolView = {
    jsx: React.ReactNode | null
    shouldHidePromptInput: boolean
    displayMode?: 'inline' | 'fullscreen'
  }

  const [toolViewStack, setToolViewStack] = useState<ToolView[]>([])
  const toolViewStackRef = useRef<ToolView[]>(toolViewStack)
  useEffect(() => {
    toolViewStackRef.current = toolViewStack
  }, [toolViewStack])

  const toolJSX: ToolView | null =
    toolViewStack.length > 0 ? toolViewStack[toolViewStack.length - 1] : null

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
      const nextTop = nextStack.length ? nextStack[nextStack.length - 1] : null
      const nextMode = nextTop?.displayMode

      const prevFull = prevMode === 'fullscreen'
      const nextFull = nextMode === 'fullscreen'

      const maybeApplyPendingForkConvoWithMessages = (): void => {
        const request = pendingForkConvoWithMessagesRef.current
        if (!request) return

        pendingForkConvoWithMessagesRef.current = null

        if (request.options?.clearViewport) {
          // Don't await; ordering of writes on stdout is preserved and this keeps
          // the transition to the restored main buffer from flashing.
          void clearViewport()
        }

        const applyStateUpdates = () => {
          setPendingForkConvoWithMessages(null)
          setForkNumber(prev => prev + 1)
          setMessages(request.messages)

          if (request.options?.resetInput) {
            setInputMode('prompt')
            setInputValue('')
            setRestorePastes(undefined)
            setDraftPastes({ pastedTexts: [], pastedImages: [] })
          }
        }

        if (batchedUpdates) {
          batchedUpdates(applyStateUpdates)
          return
        }
        applyStateUpdates()
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
          void clearViewport()
          doSetState()
          ephemeralFullscreenAltScreenRef.current = true
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
          maybeApplyPendingForkConvoWithMessages()
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
            maybeApplyPendingForkConvoWithMessages()
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
  const [toolUseConfirm, setToolUseConfirm] = useState<ToolUseConfirm | null>(
    null,
  )
  const [mcpElicitation, setMcpElicitation] =
    useState<McpElicitationPrompt | null>(null)
  const mcpElicitationRef = useRef<McpElicitationPrompt | null>(null)
  mcpElicitationRef.current = mcpElicitation

  // Let MCP servers ask the user questions while this REPL is mounted. A
  // request that arrives with no mounted UI fails closed with a decline.
  useEffect(() => {
    setMcpElicitationPresenter(prompt => {
      setMcpElicitation(prompt)
      // Lets the bridge take the form down on timeout / server cancellation.
      return () =>
        setMcpElicitation(current => (current === prompt ? null : current))
    })
    return () => {
      setMcpElicitationPresenter(null)
      const pending = mcpElicitationRef.current
      mcpElicitationRef.current = null
      pending?.resolve({ action: 'decline' })
    }
  }, [])
  const [messages, setMessages] = useState<MessageType[]>(
    props.initialMessages ?? [],
  )
  const [inputValue, setInputValue] = useState('')
  const [inputMode, setInputMode] = useState<PromptMode>('prompt')
  const [restorePastes, setRestorePastes] = useState<
    | {
        id: number
        pastedTexts: Array<{ placeholder: string; text: string }>
        pastedImages: Array<{
          placeholder: string
          data: string
          mediaType: string
        }>
      }
    | undefined
  >(undefined)
  const [draftPastes, setDraftPastes] = useState<{
    pastedTexts: Array<{ placeholder: string; text: string }>
    pastedImages: Array<{
      placeholder: string
      data: string
      mediaType: string
    }>
  }>({ pastedTexts: [], pastedImages: [] })
  const [sessionThinkingMode, setSessionThinkingMode] = useState<
    'enabled' | 'auto' | null
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

  const openTasksScreen = useCallback(() => {
    openToolView({
      jsx: <TasksScreen onDone={dismissToolView} />,
      shouldHidePromptInput: true,
      displayMode: 'fullscreen',
    })
  }, [dismissToolView, openToolView])

  const openWorkTasksScreen = useCallback(() => {
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

  const openHistorySearchScreen = useCallback(() => {
    openToolView({
      jsx: (
        <HistorySearchScreen
          onDone={result => {
            dismissToolView()

            if (result.action === 'cancel') return

            const selected = result.value
            const pastedTexts = result.pastedTexts
            const mode: PromptMode = selected.startsWith('!')
              ? 'bash'
              : selected.startsWith('&')
                ? 'background'
                : selected.startsWith('#')
                  ? 'koding'
                  : 'prompt'
            const text =
              mode === 'bash' || mode === 'background' || mode === 'koding'
                ? selected.slice(1)
                : selected

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

              const exit = (): never => {
                process.exit(0)
              }

              await submitPrompt({
                input: text,
                mode,
                completionActive: false,
                suggestionCount: 0,
                isSubmittingSlashCommand: false,
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
                onQuery: async (...args) => {
                  await onQueryRef.current?.(...args)
                },
                setToolJSX: setToolJSXWithClear,
                commands,
                forkNumber,
                messageLogName: props.messageLogName,
                tools: props.tools,
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
    openToolView,
    props.messageLogName,
    props.tools,
    safeMode,
    setAbortController,
    setForkConvoWithMessagesOnTheNextRender,
    setIsLoading,
    setToolJSXWithClear,
    verbose,
  ])

  useKeypress(
    (inputChar, key) => {
      const hasModal =
        Boolean(toolJSX) ||
        Boolean(toolUseConfirm) ||
        Boolean(mcpElicitationRef.current) ||
        Boolean(binaryFeedbackContext) ||
        showingCostDialog ||
        isMessageSelectorVisible

      if (key.ctrl && inputChar === 'c' && isLoading) {
        setToolJSXWithClear(null)
        setToolUseConfirm(null)
        setBinaryFeedbackContext(null)
        onCancel()
        return true
      }

      if (hasModal) return

      if (key.ctrl && inputChar === 't') {
        openWorkTasksScreen()
        return true
      }

      if (key.ctrl && inputChar === 'o') {
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
        return true
      }

      if (key.ctrl && inputChar === 'r') {
        openHistorySearchScreen()
        return true
      }

      if (key.meta && inputChar === 't') {
        const effectiveThinkingMode =
          sessionThinkingMode ?? getGlobalConfigCached().thinkingMode ?? 'auto'
        const currentValue = effectiveThinkingMode === 'enabled'
        const isMidConversation =
          messages.some(m => m.type === 'assistant') ||
          messages.some(m => m.type === 'user' && !(m as any)?.isMeta)

        openToolView({
          jsx: (
            <ThinkingToggleScreen
              currentValue={currentValue}
              isMidConversation={isMidConversation}
              onSelect={enabled => {
                setSessionThinkingMode(enabled ? 'enabled' : 'auto')
                showToast(`Thinking: ${enabled ? 'ON' : 'OFF'}`)
              }}
              onDone={dismissToolView}
            />
          ),
          shouldHidePromptInput: true,
          displayMode: 'fullscreen',
        })
        return true
      }

      if (key.meta && inputChar === 'p') {
        openToolView({
          jsx: (
            <ModelPickerScreen
              onDone={dismissToolView}
              onSelectModel={modelName => {
                const modelManager = getModelManager()
                modelManager.setPointer('main', modelName)
                triggerModelConfigChange()
              }}
            />
          ),
          shouldHidePromptInput: true,
          displayMode: 'fullscreen',
        })
        return true
      }

      if (inputChar === '?' && inputValue.trim().length === 0) {
        openToolView({
          jsx: <ShortcutsScreen onDone={dismissToolView} />,
          shouldHidePromptInput: true,
          displayMode: 'fullscreen',
        })
        return true
      }

      if (key.name === 'f1') {
        openToolView({
          jsx: <HelpScreen commands={commands} onDone={dismissToolView} />,
          shouldHidePromptInput: true,
          displayMode: 'fullscreen',
        })
        return true
      }

      if (key.name === 'f2') {
        openToolView({
          jsx: <ConfigScreen onClose={dismissToolView} />,
          shouldHidePromptInput: true,
          displayMode: 'fullscreen',
        })
        return true
      }

      if (key.name === 'f3') {
        openToolView({
          jsx: <OpenFileScreen onDone={dismissToolView} />,
          shouldHidePromptInput: true,
          displayMode: 'fullscreen',
        })
        return true
      }

      if (key.name === 'f4') {
        openToolView({
          jsx: <ConsoleScreen onDone={dismissToolView} />,
          shouldHidePromptInput: true,
          displayMode: 'fullscreen',
        })
        return true
      }

      if (key.name === 'f5') {
        openToolView({
          jsx: <NotificationsScreen onDone={dismissToolView} />,
          shouldHidePromptInput: true,
          displayMode: 'fullscreen',
        })
        return true
      }

      if (key.name === 'f6') {
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
        return true
      }

      if (key.name === 'f8') {
        openTasksScreen()
        return true
      }

      if (key.name === 'f7') {
        openToolView({
          jsx: (
            <CommandPaletteScreen
              onDone={action => {
                if (!action) {
                  dismissToolView()
                  return
                }

                if (action === 'help') {
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
                  openToolView({
                    jsx: <ConfigScreen onClose={dismissToolView} />,
                    shouldHidePromptInput: true,
                    displayMode: 'fullscreen',
                  })
                  return
                }

                if (action === 'open') {
                  openToolView({
                    jsx: <OpenFileScreen onDone={dismissToolView} />,
                    shouldHidePromptInput: true,
                    displayMode: 'fullscreen',
                  })
                  return
                }

                if (action === 'console') {
                  openToolView({
                    jsx: <ConsoleScreen onDone={dismissToolView} />,
                    shouldHidePromptInput: true,
                    displayMode: 'fullscreen',
                  })
                  return
                }

                if (action === 'notifications') {
                  openToolView({
                    jsx: <NotificationsScreen onDone={dismissToolView} />,
                    shouldHidePromptInput: true,
                    displayMode: 'fullscreen',
                  })
                  return
                }

                if (action === 'transcript') {
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
                  openToolView({
                    jsx: <Doctor onDone={dismissToolView} doctorMode={true} />,
                    shouldHidePromptInput: true,
                    displayMode: 'fullscreen',
                  })
                  return
                }

                if (action === 'model') {
                  try {
                    abortController?.abort?.()
                  } catch {}
                  setIsLoading(false)

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
        return true
      }
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

  const onCancel = useCallback(() => {
    if (!isLoading) return
    setIsLoading(false)

    // Cancelling a pending elicitation must not silently end the turn: the tool
    // call that triggered it is still running, so fall through and abort that
    // too instead of returning early.
    const pending = mcpElicitationRef.current
    if (pending) {
      mcpElicitationRef.current = null
      setMcpElicitation(null)
      pending.resolve({ action: 'cancel' })
    }

    if (toolUseConfirm) {
      toolUseConfirm.onAbort()
      return
    }
    if (abortController && !abortController.signal.aborted) {
      abortController.abort()
    }
  }, [abortController, isLoading, toolUseConfirm])

  useCancelRequest(
    setToolJSXWithClear,
    setToolUseConfirm,
    setBinaryFeedbackContext,
    onCancel,
    isLoading,
    isMessageSelectorVisible,
    abortController?.signal,
  )

  useEffect(() => {
    if (!pendingForkConvoWithMessages) return

    // If a fullscreen tool view is still mounted, we may still be on the
    // alternate screen buffer (ephemeral fullscreen mode). Wait until the view
    // is dismissed so clears apply to the active REPL buffer.
    if (toolJSX?.displayMode === 'fullscreen') return

    const request = pendingForkConvoWithMessages
    setPendingForkConvoWithMessages(null)
    pendingForkConvoWithMessagesRef.current = null

    // For non-fullscreen forks, handle clearViewport synchronously then update state
    // This matches the old pattern where clearTerminal was called before state updates
    const applyStateUpdates = () => {
      setForkNumber(prev => prev + 1)
      setMessages(request.messages)

      if (request.options?.resetInput) {
        setInputMode('prompt')
        setInputValue('')
        setRestorePastes(undefined)
        setDraftPastes({ pastedTexts: [], pastedImages: [] })
      }
    }

    // clearViewport is async but we don't need to await it - the terminal
    // writes are ordered on stdout, so the clear happens before React renders
    if (request.options?.clearViewport) {
      void clearViewport()
    }

    if (batchedUpdates) {
      batchedUpdates(applyStateUpdates)
    } else {
      applyStateUpdates()
    }
  }, [pendingForkConvoWithMessages, toolJSX?.displayMode])

  useEffect(() => {
    const totalCost = getTotalCost()
    if (totalCost >= 5 && !showCostDialog && !haveShownCostDialog) {
      setShowCostDialog(true)
    }
  }, [messages, showCostDialog, haveShownCostDialog])

  const showToast = useCallback((text: string) => {
    setToast(text)
    if (toastTimeoutRef.current) {
      clearTimeout(toastTimeoutRef.current)
    }
    toastTimeoutRef.current = setTimeout(() => setToast(null), 6000)
  }, [])

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

  const canUseTool = useCanUseTool(setToolUseConfirm, {
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
    tools: props.tools,
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
    setIsLoading,
  })
  useEffect(() => {
    onQueryRef.current = onQuery
  }, [onQuery])

  const onInit = useReplInit({
    initialPrompt: props.initialPrompt,
    commands,
    forkNumber,
    messageLogName: props.messageLogName,
    tools: props.tools,
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
    setHaveShownCostDialog,
    onQuery,
  })

  useCostSummary()

  useEffect(() => {
    setMessagesGetter(() => messages)
    setMessagesSetter(setMessages)
  }, [messages])

  useEffect(() => {
    setModelConfigChangeHandler(() => setUiRefreshCounter(prev => prev + 1))
  }, [])

  useLogMessages(messages, props.messageLogName, forkNumber)
  useLogStartupTime()

  useEffect(() => {
    onInit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const transcript = useTranscriptItems({
    messages,
    tools: props.tools,
    verbose,
    debug,
    toolJSX,
    toolUseConfirm,
    isMessageSelectorVisible,
    forkNumber,
  })

  const staticItemsRef = useRef<TranscriptItem[]>([])
  const printedKeysRef = useRef<Set<string>>(new Set())
  const lastForkNumberRef = useRef<number>(forkNumber)

  const staticItems = useMemo(() => {
    // Reset when forkNumber changes (conversation fork)
    if (lastForkNumberRef.current !== forkNumber) {
      lastForkNumberRef.current = forkNumber
      staticItemsRef.current = []
      printedKeysRef.current = new Set()
    }

    const items: TranscriptItem[] = []

    // Always include logo as first item
    const logoKey = `logo-${forkNumber}`
    items.push({
      key: logoKey,
      jsx: (
        <Box flexDirection="column" key={logoKey}>
          <Logo
            mcpClients={mcpClients}
            isDefaultModel={isDefaultModel}
            updateBannerVersion={updateAvailableVersion}
            updateBannerCommands={updateCommands}
          />
          <ProjectOnboarding workspaceDir={getOriginalCwd()} />
        </Box>
      ),
    })

    items.push(...transcript.items.slice(0, transcript.replStaticPrefixLength))

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
    forkNumber,
    isDefaultModel,
    mcpClients,
    transcript.items,
    transcript.replStaticPrefixLength,
    updateAvailableVersion,
    updateCommands,
  ])

  const transientItems = useMemo(
    () => transcript.items.slice(transcript.replStaticPrefixLength),
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

  const promptInputProps = buildPromptInputProps({
    commands,
    forkNumber,
    messageLogName: props.messageLogName,
    initialPrompt: props.initialPrompt,
    tools: props.tools,
    disableSlashCommands,
    isDisabled: apiKeyStatus !== 'valid',
    isLoading,
    onQuery,
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
    uiRefreshCounter,
    onShowMessageSelector: () => setIsMessageSelectorVisible(prev => !prev),
    setForkConvoWithMessagesOnTheNextRender,
    readFileTimestamps: readFileTimestampsRef.current,
    abortController,
    onManageTasks: openTasksScreen,
    restorePastes,
    onRestorePastesApplied: id => {
      setRestorePastes(prev => {
        if (!prev) return prev
        if (prev.id !== id) return prev
        return undefined
      })
    },
    draftPastes,
    onDraftPastesChange: setDraftPastes,
  })

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
    forkNumber,
    staticItems,
    transientItems,
    toolJSX,
    toolUseConfirm,
    setToolUseConfirm,
    mcpElicitation,
    setMcpElicitation,
    toast,
    binaryFeedbackContext,
    setBinaryFeedbackContext,
    isLoading,
    verbose,
    normalizedMessages: transcript.normalizedMessages,
    tools: props.tools,
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
