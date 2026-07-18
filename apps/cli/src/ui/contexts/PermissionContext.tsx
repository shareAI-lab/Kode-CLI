import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  ReactNode,
} from 'react'
import {
  PermissionMode,
  PermissionContext as IPermissionContext,
  getNextPermissionMode,
  MODE_CONFIGS,
} from '#core/types/PermissionMode'
import {
  getPermissionModeForConversationKey,
  setPermissionModeForConversationKey,
} from '#core/utils/permissionModeState'
import type {
  ToolPermissionContext as IToolPermissionContext,
  ToolPermissionContextUpdate,
} from '#core/types/toolPermissionContext'
import { applyToolPermissionContextUpdate } from '#core/types/toolPermissionContext'
import {
  applyToolPermissionContextUpdateForConversationKey,
  getToolPermissionContextForConversationKey,
  setToolPermissionContextForConversationKey,
  subscribeToolPermissionContextUpdates,
} from '#core/utils/toolPermissionContextState'
import {
  enterPlanModeForConversationKey,
  exitPlanModeForConversationKey,
  isPlanModeEnabledForConversationKey,
  setActivePlanConversationKey,
} from '#core/utils/planMode'
import { getGlobalConfig, saveGlobalConfig } from '#core/utils/config'
import { __applyPermissionModeSideEffectsForTests } from './permissionModeSideEffects'
import { LEGACY_ENV } from '#core/compat/legacyEnv'

const PLAN_MODE_REQUIRED_VALUES = new Set([
  '1',
  'true',
  'yes',
  'y',
  'on',
  'enable',
  'enabled',
])

const planModeRequiredAppliedByConversationKey = new Set<string>()

function isPlanModeRequired(): boolean {
  const raw =
    process.env.KODE_PLAN_MODE_REQUIRED ??
    process.env[LEGACY_ENV.codePlanModeRequired]
  if (!raw) return false
  return PLAN_MODE_REQUIRED_VALUES.has(raw.trim().toLowerCase())
}

function getToolPermissionContextWithPlanModeRequired(args: {
  conversationKey: string
  isBypassPermissionsModeAvailable: boolean
}): IToolPermissionContext {
  const toolCtx = getToolPermissionContextForConversationKey({
    conversationKey: args.conversationKey,
    isBypassPermissionsModeAvailable: args.isBypassPermissionsModeAvailable,
  })

  if (!isPlanModeRequired()) return toolCtx
  if (planModeRequiredAppliedByConversationKey.has(args.conversationKey))
    return toolCtx
  planModeRequiredAppliedByConversationKey.add(args.conversationKey)

  if (toolCtx.mode === 'plan') return toolCtx
  return applyToolPermissionContextUpdateForConversationKey({
    conversationKey: args.conversationKey,
    isBypassPermissionsModeAvailable: args.isBypassPermissionsModeAvailable,
    update: { type: 'setMode', mode: 'plan', destination: 'session' },
  })
}

interface PermissionContextValue {
  permissionContext: IPermissionContext
  toolPermissionContext: IToolPermissionContext
  currentMode: PermissionMode
  conversationKey: string
  cycleMode: () => void
  setMode: (mode: PermissionMode) => void
  applyToolPermissionUpdate: (update: ToolPermissionContextUpdate) => void
  isToolAllowed: (toolName: string) => boolean
  getModeConfig: () => (typeof MODE_CONFIGS)[PermissionMode]
}

const PermissionContext = createContext<PermissionContextValue | undefined>(
  undefined,
)

interface PermissionProviderProps {
  children?: ReactNode
  conversationKey: string
  isBypassPermissionsModeAvailable?: boolean
}

export { __applyPermissionModeSideEffectsForTests }

export function PermissionProvider({
  children,
  conversationKey,
  isBypassPermissionsModeAvailable = false,
}: PermissionProviderProps) {
  const [toolPermissionContext, setToolPermissionContext] =
    useState<IToolPermissionContext>(() =>
      getToolPermissionContextWithPlanModeRequired({
        conversationKey,
        isBypassPermissionsModeAvailable,
      }),
    )
  const [permissionContext, setPermissionContext] =
    useState<IPermissionContext>(() => {
      const initialMode = getToolPermissionContextWithPlanModeRequired({
        conversationKey,
        isBypassPermissionsModeAvailable,
      }).mode
      const initialConfig = MODE_CONFIGS[initialMode]
      return {
        mode: initialMode,
        allowedTools: initialConfig.allowedTools,
        allowedPaths: [process.cwd()],
        restrictions: initialConfig.restrictions,
        metadata: {
          transitionCount: 0,
        },
      }
    })

  const permissionContextRef = useRef(permissionContext)
  useEffect(() => {
    permissionContextRef.current = permissionContext
  }, [permissionContext])

  const toolPermissionContextRef = useRef(toolPermissionContext)
  useEffect(() => {
    toolPermissionContextRef.current = toolPermissionContext
  }, [toolPermissionContext])

  useEffect(() => {
    const toolCtx = getToolPermissionContextWithPlanModeRequired({
      conversationKey,
      isBypassPermissionsModeAvailable,
    })
    setToolPermissionContext(toolCtx)
    const config = MODE_CONFIGS[toolCtx.mode]
    setPermissionContext({
      mode: toolCtx.mode,
      allowedTools: config.allowedTools,
      allowedPaths: [process.cwd()],
      restrictions: config.restrictions,
      metadata: {
        transitionCount: 0,
      },
    })
  }, [conversationKey, isBypassPermissionsModeAvailable])

  useEffect(() => {
    return subscribeToolPermissionContextUpdates(event => {
      if (event.conversationKey !== conversationKey) return

      setToolPermissionContext(event.context)

      const nextMode = event.context.mode
      setPermissionContext(prev => {
        if (prev.mode === nextMode) return prev
        const config = MODE_CONFIGS[nextMode]
        return {
          ...prev,
          mode: nextMode,
          allowedTools: config.allowedTools,
          restrictions: config.restrictions,
          metadata: {
            ...prev.metadata,
            previousMode: prev.mode,
            activatedAt: new Date().toISOString(),
            transitionCount: prev.metadata.transitionCount + 1,
          },
        }
      })
    })
  }, [conversationKey])

  const planModeSyncRef = useRef<{
    conversationKey: string
    mode: PermissionMode
  } | null>(null)

  useEffect(() => {
    setActivePlanConversationKey(conversationKey)

    const previous = planModeSyncRef.current
    if (!previous || previous.conversationKey !== conversationKey) {
      planModeSyncRef.current = {
        conversationKey,
        mode: permissionContext.mode,
      }
      const planModeEnabled =
        isPlanModeEnabledForConversationKey(conversationKey)
      if (permissionContext.mode === 'plan' && !planModeEnabled) {
        enterPlanModeForConversationKey(conversationKey)
      } else if (permissionContext.mode !== 'plan' && planModeEnabled) {
        exitPlanModeForConversationKey(conversationKey)
      }
      return
    }

    if (previous.mode === permissionContext.mode) return

    if (previous.mode !== 'plan' && permissionContext.mode === 'plan') {
      enterPlanModeForConversationKey(conversationKey)
    } else if (previous.mode === 'plan' && permissionContext.mode !== 'plan') {
      exitPlanModeForConversationKey(conversationKey)
    }

    planModeSyncRef.current = {
      conversationKey,
      mode: permissionContext.mode,
    }
  }, [conversationKey, permissionContext.mode])

  const cycleMode = useCallback(() => {
    const prev = permissionContextRef.current
    const nextMode = getNextPermissionMode(
      prev.mode,
      isBypassPermissionsModeAvailable,
    )
    const modeConfig = MODE_CONFIGS[nextMode]

    __applyPermissionModeSideEffectsForTests({
      conversationKey,
      previousMode: prev.mode,
      nextMode,
      recordPlanModeUse: true,
    })

    const updatedToolPermissionContext =
      applyToolPermissionContextUpdateForConversationKey({
        conversationKey,
        isBypassPermissionsModeAvailable,
        update: { type: 'setMode', mode: nextMode, destination: 'session' },
      })
    toolPermissionContextRef.current = updatedToolPermissionContext
    setToolPermissionContext(updatedToolPermissionContext)

    const nextPermissionContext: IPermissionContext = {
      ...prev,
      mode: nextMode,
      allowedTools: modeConfig.allowedTools,
      restrictions: modeConfig.restrictions,
      metadata: {
        ...prev.metadata,
        previousMode: prev.mode,
        activatedAt: new Date().toISOString(),
        transitionCount: prev.metadata.transitionCount + 1,
      },
    }
    permissionContextRef.current = nextPermissionContext
    setPermissionContext(nextPermissionContext)
  }, [conversationKey, isBypassPermissionsModeAvailable])

  const setMode = useCallback(
    (mode: PermissionMode) => {
      const prev = permissionContextRef.current
      if (prev.mode === mode) return

      const modeConfig = MODE_CONFIGS[mode]

      __applyPermissionModeSideEffectsForTests({
        conversationKey,
        previousMode: prev.mode,
        nextMode: mode,
        recordPlanModeUse: false,
      })

      const updatedToolPermissionContext =
        applyToolPermissionContextUpdateForConversationKey({
          conversationKey,
          isBypassPermissionsModeAvailable,
          update: { type: 'setMode', mode, destination: 'session' },
        })
      toolPermissionContextRef.current = updatedToolPermissionContext
      setToolPermissionContext(updatedToolPermissionContext)

      const nextPermissionContext: IPermissionContext = {
        ...prev,
        mode,
        allowedTools: modeConfig.allowedTools,
        restrictions: modeConfig.restrictions,
        metadata: {
          ...prev.metadata,
          previousMode: prev.mode,
          activatedAt: new Date().toISOString(),
          transitionCount: prev.metadata.transitionCount + 1,
        },
      }
      permissionContextRef.current = nextPermissionContext
      setPermissionContext(nextPermissionContext)
    },
    [conversationKey, isBypassPermissionsModeAvailable],
  )

  const applyToolPermissionUpdate = useCallback(
    (update: ToolPermissionContextUpdate) => {
      const previousToolCtx = toolPermissionContextRef.current
      const nextToolCtx = applyToolPermissionContextUpdate(
        previousToolCtx,
        update,
      )
      toolPermissionContextRef.current = nextToolCtx
      setToolPermissionContext(nextToolCtx)
      setToolPermissionContextForConversationKey({
        conversationKey,
        context: nextToolCtx,
      })

      if (update.type === 'setMode') {
        const prev = permissionContextRef.current
        if (prev.mode === update.mode) return

        const modeConfig = MODE_CONFIGS[update.mode]

        __applyPermissionModeSideEffectsForTests({
          conversationKey,
          previousMode: prev.mode,
          nextMode: update.mode,
          recordPlanModeUse: false,
        })

        const nextPermissionContext: IPermissionContext = {
          ...prev,
          mode: update.mode,
          allowedTools: modeConfig.allowedTools,
          restrictions: modeConfig.restrictions,
          metadata: {
            ...prev.metadata,
            previousMode: prev.mode,
            activatedAt: new Date().toISOString(),
            transitionCount: prev.metadata.transitionCount + 1,
          },
        }
        permissionContextRef.current = nextPermissionContext
        setPermissionContext(nextPermissionContext)
      }
    },
    [conversationKey],
  )

  const isToolAllowed = useCallback(
    (toolName: string) => {
      const { allowedTools } = permissionContext

      // If '*' is in allowed tools, all tools are allowed
      if (allowedTools.includes('*')) {
        return true
      }

      // Check if specific tool is in allowed list
      return allowedTools.includes(toolName)
    },
    [permissionContext],
  )

  const getModeConfig = useCallback(() => {
    return MODE_CONFIGS[permissionContext.mode]
  }, [permissionContext.mode])

  const value: PermissionContextValue = {
    permissionContext,
    toolPermissionContext,
    currentMode: permissionContext.mode,
    conversationKey,
    cycleMode,
    setMode,
    applyToolPermissionUpdate,
    isToolAllowed,
    getModeConfig,
  }

  return (
    <PermissionContext.Provider value={value}>
      {children}
    </PermissionContext.Provider>
  )
}

export function usePermissionContext(): PermissionContextValue {
  const context = useContext(PermissionContext)
  if (context === undefined) {
    throw new Error(
      'usePermissionContext must be used within a PermissionProvider',
    )
  }
  return context
}

// Hook for components that need to respond to permission mode changes
export function usePermissionMode(): [
  PermissionMode,
  (mode: PermissionMode) => void,
  () => void,
] {
  const { currentMode, setMode, cycleMode } = usePermissionContext()
  return [currentMode, setMode, cycleMode]
}
