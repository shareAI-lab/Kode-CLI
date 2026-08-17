import { Box, Text } from 'ink'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import figures from 'figures'
import type { ToolUseConfirm } from '#ui-ink/components/permissions/PermissionRequest'
import { getTheme } from '#core/utils/theme'
import { usePermissionContext } from '#ui-ink/contexts/PermissionContext'
import { PRODUCT_NAME } from '#core/constants/product'
import {
  getPlanConversationKey,
  getPlanFilePath,
  readPlanFile,
} from '#core/utils/planMode'
import {
  getExternalEditorLabel,
  launchExternalEditor,
  launchExternalEditorForFilePath,
} from '#cli-utils/externalEditor'
import { writeFileSync } from 'fs'
import {
  type ExitPlanModeOptionValue,
  getExitPlanModeOptions,
} from './ExitPlanModeOptions'
import { useKeypress } from '#ui-ink/hooks/useKeypress'
import { useTerminalSize } from '#ui-ink/hooks/useTerminalSize'
import { ScreenFrame } from '#ui-ink/primitives/layout/ScreenFrame'
import { useScreenLayout } from '#ui-ink/primitives/layout/useScreenLayout'
import { computeAvailableColumns } from '#ui-ink/primitives/layout/viewportColumns'
import { computeResponsiveRows } from '#ui-ink/primitives/layout/viewportRows'
import { getWindowedList } from '#ui-ink/primitives/list/windowedList'
import { wrapLines } from '#ui-ink/primitives/text/wrapLines'
import { getPermissionModeCycleShortcut } from '#ui-ink/utils/permissionModeCycleShortcut'
import type { PermissionMode } from '#core/types/PermissionMode'
import { applyToolPermissionContextUpdateForConversationKey } from '#core/utils/toolPermissionContextState'
import { getMessagesSetter } from '#core/messages'
import { getContext } from '@kode/context'
import { getCodeStyle } from '#core/utils/style'
import { resetReminderSession } from '#core/services/systemReminder'
import { resetFileFreshnessSession } from '#core/services/fileFreshness'
import { formatBashPromptRule } from '@kode/permissions/bash'
import { LEGACY_ENV } from '#core/compat/legacyEnv'
import { permissionSelectFocusScope } from '#ui-ink/components/permissions/permissionFocusScope'
import { useScopedIndexState } from '#ui-ink/hooks/useScopedIndexState'

type Props = {
  toolUseConfirm: ToolUseConfirm
  onDone(): void
  verbose: boolean
}

export { __getExitPlanModeOptionsForTests } from './ExitPlanModeOptions'

function planPlaceholder(): string {
  return 'No plan found. Please write your plan to the plan file first.'
}

function clearConversationContextForPlanExit(): void {
  getMessagesSetter()([])
  getContext.cache.clear?.()
  getCodeStyle.cache.clear?.()
  resetReminderSession()
  resetFileFreshnessSession()
}

type AllowedPrompt = { tool: 'Bash'; prompt: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseAllowedPrompts(value: unknown): AllowedPrompt[] | null {
  if (!Array.isArray(value)) return null
  const out: AllowedPrompt[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    if (item.tool !== 'Bash') continue
    const prompt = typeof item.prompt === 'string' ? item.prompt : ''
    if (!prompt.trim()) continue
    out.push({ tool: 'Bash', prompt })
  }
  return out.length > 0 ? out : null
}

const TRUTHY_ENV_VALUES = new Set(['1', 'true', 'yes', 'on'])

function isTruthyEnv(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return TRUTHY_ENV_VALUES.has(value.trim().toLowerCase())
}

function isPlanExitSwarmEnabled(): boolean {
  const raw =
    process.env.KODE_PLAN_V2_AGENT_COUNT ??
    process.env[LEGACY_ENV.codePlanV2AgentCount]
  if (!raw) return false
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 1
}

function isPlanExitPushToRemoteEnabled(): boolean {
  return isTruthyEnv(process.env.KODE_PLAN_PUSH_TO_REMOTE)
}

export function ExitPlanModePermissionRequest({
  toolUseConfirm,
  onDone,
}: Props): React.ReactNode {
  const theme = getTheme()
  const layout = useScreenLayout()
  const { columns, rows } = useTerminalSize()
  const { setMode } = usePermissionContext()
  const modeCycleShortcut = useMemo(() => getPermissionModeCycleShortcut(), [])

  const conversationKey = getPlanConversationKey(toolUseConfirm.toolUseContext)
  const planFilePath = useMemo(
    () => getPlanFilePath(undefined, conversationKey),
    [conversationKey],
  )
  const allowedPrompts = parseAllowedPrompts(
    toolUseConfirm.input['allowedPrompts'],
  )
  const allowedPromptCount = allowedPrompts?.length ?? 0
  const hasAllowedPrompts = allowedPrompts !== null

  const [planText, setPlanText] = useState(() => {
    const { content, exists } = readPlanFile(undefined, conversationKey)
    return exists ? content : planPlaceholder()
  })
  const [planExists, setPlanExists] = useState(() => {
    const { exists } = readPlanFile(undefined, conversationKey)
    return exists
  })
  const [planSaved, setPlanSaved] = useState(false)
  const [editorLabel, setEditorLabel] = useState(() => getExternalEditorLabel())
  const [editorStatus, setEditorStatus] = useState<{
    kind: 'opening' | 'error'
    message: string
  } | null>(null)
  const [rejectDraft, setRejectDraft] = useState('')
  const [selectedAllowedPromptIndices, setSelectedAllowedPromptIndices] =
    useState<number[]>(() =>
      allowedPrompts ? allowedPrompts.map((_, i) => i) : [],
    )
  const [swarmTeammateCount, setSwarmTeammateCount] = useState(3)
  const [remoteExitState, setRemoteExitState] = useState<
    'default' | 'checking' | 'unavailable'
  >('default')
  const [remoteExitMessage, setRemoteExitMessage] = useState<string | null>(
    null,
  )
  const isOpeningEditorRef = useRef(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      isOpeningEditorRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!planSaved) return undefined
    const timeout = setTimeout(() => setPlanSaved(false), 5000)
    return () => clearTimeout(timeout)
  }, [planSaved])

  const planViewportWidth = computeAvailableColumns({
    columns,
    reservedColumns: layout.paddingX * 2 + 2,
  })
  const planLines = useMemo(
    () => wrapLines(planText.split('\n'), planViewportWidth),
    [planText, planViewportWidth],
  )
  const showExitWithoutPlan = !planExists || planText.trim().length === 0
  const pushToRemoteAvailable = useMemo(
    () => isPlanExitPushToRemoteEnabled(),
    [],
  )
  const swarmAvailable = useMemo(() => isPlanExitSwarmEnabled(), [])
  const options = useMemo(() => {
    return getExitPlanModeOptions({
      pushToRemoteAvailable,
      swarmAvailable,
      teammateCount: swarmTeammateCount,
      quickSelectLabel: modeCycleShortcut.displayText,
    })
  }, [
    modeCycleShortcut.displayText,
    pushToRemoteAvailable,
    swarmAvailable,
    swarmTeammateCount,
  ])
  const focusScope = useMemo(
    () => permissionSelectFocusScope(toolUseConfirm, 'exit-plan-mode'),
    [toolUseConfirm],
  )
  const [focusedOptionIndex, setFocusedOptionIndex] = useScopedIndexState({
    scope: `${focusScope}:option`,
    itemCount: Math.max(1, showExitWithoutPlan ? 2 : options.length),
  })
  const [planFocusIndex, setPlanFocusIndex] = useScopedIndexState({
    scope: `${focusScope}:plan-preview`,
    itemCount: Math.max(1, planLines.length),
  })
  const [focusedAllowedPromptIndex, setFocusedAllowedPromptIndex] =
    useScopedIndexState({
      scope: `${focusScope}:allowed-prompts`,
      itemCount: Math.max(1, allowedPrompts?.length ?? 1),
    })
  const [focusSectionIndex, setFocusSectionIndex] = useScopedIndexState({
    scope: `${focusScope}:section`,
    itemCount: hasAllowedPrompts ? 2 : 1,
  })
  const focusSection =
    hasAllowedPrompts && focusSectionIndex === 1 ? 'permissions' : 'options'
  const setFocusSection = (next: 'options' | 'permissions') => {
    setFocusSectionIndex(next === 'permissions' && hasAllowedPrompts ? 1 : 0)
  }

  useEffect(() => {
    if (!hasAllowedPrompts) return
    setFocusedAllowedPromptIndex(prev =>
      Math.max(0, Math.min(prev, allowedPromptCount - 1)),
    )
    setSelectedAllowedPromptIndices(prev =>
      prev.filter(idx => idx >= 0 && idx < allowedPromptCount),
    )
  }, [allowedPromptCount, hasAllowedPrompts, setFocusedAllowedPromptIndex])

  useEffect(() => {
    setPlanFocusIndex(prev => {
      if (planLines.length === 0) return 0
      return Math.max(0, Math.min(prev, planLines.length - 1))
    })
  }, [planLines.length, setPlanFocusIndex])

  useEffect(() => {
    setFocusedOptionIndex(prev =>
      Math.max(0, Math.min(prev, options.length - 1)),
    )
  }, [options.length, setFocusedOptionIndex])

  useEffect(() => {
    if (!showExitWithoutPlan) return
    setFocusedOptionIndex(prev => Math.max(0, Math.min(prev, 1)))
  }, [showExitWithoutPlan, setFocusedOptionIndex])

  const planViewportRows = computeResponsiveRows({
    rows,
    reservedRows: 8,
    minRows: 2,
    maxRows: 14,
    ratio: 0.4,
  })
  const planWindow = useMemo(
    () =>
      getWindowedList({
        itemCount: planLines.length,
        focusIndex: planFocusIndex,
        maxVisible: planViewportRows,
        indicatorRows: 2,
      }),
    [planFocusIndex, planLines.length, planViewportRows],
  )

  const applyPermissionMode = (nextMode: PermissionMode) => {
    const conversationKey = getPlanConversationKey(
      toolUseConfirm.toolUseContext,
    )
    const safeMode = toolUseConfirm.toolUseContext.options?.safeMode === true
    const updatedToolPermissionContext =
      applyToolPermissionContextUpdateForConversationKey({
        conversationKey,
        isBypassPermissionsModeAvailable: !safeMode,
        update: { type: 'setMode', mode: nextMode, destination: 'session' },
      })

    toolUseConfirm.toolUseContext.options ??= {}
    toolUseConfirm.toolUseContext.options.toolPermissionContext =
      updatedToolPermissionContext

    setMode(nextMode)
  }

  const applyAllowedPromptsToSessionRules = () => {
    if (!allowedPrompts || selectedAllowedPromptIndices.length === 0) return

    const selected = new Set(selectedAllowedPromptIndices)
    const rules = allowedPrompts
      .filter((_prompt, idx) => selected.has(idx))
      .map(prompt => formatBashPromptRule(prompt.prompt))
      .filter(Boolean)
    const deduped = Array.from(new Set(rules))
    if (deduped.length === 0) return

    const safeMode = toolUseConfirm.toolUseContext.options?.safeMode === true
    const updatedToolPermissionContext =
      applyToolPermissionContextUpdateForConversationKey({
        conversationKey,
        isBypassPermissionsModeAvailable: !safeMode,
        update: {
          type: 'addRules',
          destination: 'session',
          behavior: 'allow',
          rules: deduped,
        },
      })
    toolUseConfirm.toolUseContext.options ??= {}
    toolUseConfirm.toolUseContext.options.toolPermissionContext =
      updatedToolPermissionContext
  }

  const startPushToRemoteFlow = () => {
    setRemoteExitMessage(null)
    setRemoteExitState('checking')

    void (async () => {
      // Kode currently exposes remote-session headers for compat, but does not yet
      // implement remote session creation. Keep the UX path consistent and fail
      // gracefully until the remote agent runtime is finalized.
      setRemoteExitMessage(
        'Remote sessions are not configured for this build. If you already have a remote session ID, set KODE_REMOTE_SESSION_ID and retry.',
      )
      setRemoteExitState('unavailable')
    })()
  }

  const handleApprove = (value: ExitPlanModeOptionValue) => {
    let updatedInput: { [key: string]: unknown } | undefined
    const clearContext = value === 'yes-accept-edits'

    let nextMode: PermissionMode = 'cautious'
    switch (value) {
      case 'yes-push-to-remote':
        startPushToRemoteFlow()
        return
      case 'yes-accept-edits':
        nextMode = 'acceptEdits'
        break
      case 'yes-launch-swarm-accept-edits':
        nextMode = 'acceptEdits'
        updatedInput = {
          ...toolUseConfirm.input,
          launchSwarm: true,
          teammateCount: swarmTeammateCount,
        }
        break
      case 'yes-accept-edits-keep-context':
        nextMode = 'acceptEdits'
        break
      case 'yes-cautious-keep-context':
        nextMode = 'cautious'
        break
      case 'no':
        return
      default: {
        const neverValue: never = value
        throw new Error(`Unexpected ExitPlanMode option: ${String(neverValue)}`)
      }
    }

    applyPermissionMode(nextMode)
    applyAllowedPromptsToSessionRules()

    if (clearContext) {
      clearConversationContextForPlanExit()
    }

    if (updatedInput) {
      toolUseConfirm.onAllow('temporary', { updatedInput })
    } else {
      toolUseConfirm.onAllow('temporary')
    }
    onDone()
  }

  const openPlanInEditor = useCallback(async () => {
    if (isOpeningEditorRef.current) return

    isOpeningEditorRef.current = true
    setEditorStatus({ kind: 'opening', message: 'Opening external editor…' })

    try {
      if (!planExists) {
        const initial = planText === planPlaceholder() ? '# Plan\n' : planText
        try {
          writeFileSync(planFilePath, initial, 'utf-8')
        } catch {
          const edited = await launchExternalEditor(initial)
          if (!mountedRef.current) return

          if ('editorLabel' in edited && edited.editorLabel) {
            setEditorLabel(edited.editorLabel)
          }
          if (edited.text !== null) {
            setPlanText(edited.text)
            setPlanSaved(true)
            setEditorStatus(null)
          } else {
            setEditorStatus({
              kind: 'error',
              message:
                ('error' in edited ? edited.error?.message : undefined) ??
                'Unable to open the external editor. Check $EDITOR and try again.',
            })
          }
          return
        }
      }

      const opened = await launchExternalEditorForFilePath(planFilePath)
      if (!mountedRef.current) return

      if ('editorLabel' in opened && opened.editorLabel) {
        setEditorLabel(opened.editorLabel)
      }
      if (opened.ok) {
        const next = readPlanFile(undefined, conversationKey)
        setPlanExists(next.exists)
        setPlanText(next.exists ? next.content : planPlaceholder())
        setPlanSaved(true)
        setEditorStatus(null)
      } else {
        setEditorStatus({
          kind: 'error',
          message:
            opened.error.message ||
            'Unable to open the external editor. Check $EDITOR and try again.',
        })
      }
    } catch {
      if (mountedRef.current) {
        setEditorStatus({
          kind: 'error',
          message:
            'Unable to open the external editor. Check $EDITOR and try again.',
        })
      }
    } finally {
      isOpeningEditorRef.current = false
    }
  }, [conversationKey, planExists, planFilePath, planText])

  useKeypress((input, key) => {
    if (remoteExitState !== 'default') {
      if (key.escape) {
        setRemoteExitState('default')
        setRemoteExitMessage(null)
        return true
      }
      return undefined
    }

    if (key.escape) {
      toolUseConfirm.onReject()
      onDone()
      return true
    }

    if (showExitWithoutPlan) {
      if (key.upArrow) {
        setFocusedOptionIndex(0)
        return true
      }

      if (key.downArrow) {
        setFocusedOptionIndex(1)
        return true
      }

      if (key.return) {
        if (focusedOptionIndex === 0) {
          applyPermissionMode('acceptEdits')
          toolUseConfirm.onAllow('temporary')
          onDone()
          return true
        }

        toolUseConfirm.onReject()
        onDone()
        return true
      }

      return undefined
    }

    if (focusSection === 'options' && modeCycleShortcut.check(input, key)) {
      // Quick-select only fires while an approval option is focused. When the
      // user moved focus to the "No, keep planning" input, shift+tab must not
      // silently approve and switch permission modes behind their back.
      const focusedOption = options[focusedOptionIndex]
      // Non-input options are approval options by construction: the only
      // "no" option is the typed input row.
      const isApprovalOption =
        focusedOption !== undefined &&
        'value' in focusedOption &&
        focusedOption.type !== 'input'
      if (isApprovalOption) {
        const quickValue: ExitPlanModeOptionValue = 'yes-accept-edits'
        handleApprove(quickValue)
        return true
      }
      return undefined
    }

    if (key.pageUp && !showExitWithoutPlan) {
      setPlanFocusIndex(prev => Math.max(0, prev - planWindow.visibleCount))
      return true
    }

    if (key.pageDown && !showExitWithoutPlan) {
      setPlanFocusIndex(prev =>
        Math.min(
          Math.max(0, planLines.length - 1),
          prev + planWindow.visibleCount,
        ),
      )
      return true
    }

    if (key.home && !showExitWithoutPlan) {
      setPlanFocusIndex(0)
      return true
    }

    if (key.end && !showExitWithoutPlan) {
      setPlanFocusIndex(Math.max(0, planLines.length - 1))
      return true
    }

    if (key.upArrow) {
      if (hasAllowedPrompts && focusSection === 'options') {
        if (focusedOptionIndex === 0) {
          setFocusSection('permissions')
          setFocusedAllowedPromptIndex(
            Math.max(0, (allowedPrompts?.length ?? 1) - 1),
          )
          return true
        }
        setFocusedOptionIndex(prev => Math.max(0, prev - 1))
        return true
      }

      if (hasAllowedPrompts && focusSection === 'permissions') {
        setFocusedAllowedPromptIndex(prev => Math.max(0, prev - 1))
        return true
      }

      setFocusedOptionIndex(prev => Math.max(0, prev - 1))
      return true
    }

    if (key.downArrow) {
      if (hasAllowedPrompts && focusSection === 'permissions') {
        if (focusedAllowedPromptIndex >= (allowedPrompts?.length ?? 1) - 1) {
          setFocusSection('options')
          setFocusedOptionIndex(0)
          return true
        }
        setFocusedAllowedPromptIndex(prev =>
          Math.min((allowedPrompts?.length ?? 1) - 1, prev + 1),
        )
        return true
      }

      setFocusedOptionIndex(prev => Math.min(options.length - 1, prev + 1))
      return true
    }

    const focusedOption = options[focusedOptionIndex]

    if (key.tab && !key.shift && focusSection === 'options') {
      const swarmValues: ExitPlanModeOptionValue[] = [
        'yes-launch-swarm-accept-edits',
      ]
      if (
        focusedOption &&
        'value' in focusedOption &&
        swarmValues.includes(focusedOption.value)
      ) {
        const choices = [1, 2, 3, 4, 5]
        setSwarmTeammateCount(prev => {
          const idx = Math.max(0, choices.indexOf(prev))
          return choices[(idx + 1) % choices.length] ?? 3
        })
        return true
      }
    }

    if (key.return) {
      if (
        hasAllowedPrompts &&
        focusSection === 'permissions' &&
        allowedPrompts
      ) {
        setSelectedAllowedPromptIndices(prev => {
          const next = new Set(prev)
          if (next.has(focusedAllowedPromptIndex)) {
            next.delete(focusedAllowedPromptIndex)
          } else {
            next.add(focusedAllowedPromptIndex)
          }
          return Array.from(next).sort((a, b) => a - b)
        })
        return true
      }

      if (focusedOption?.type === 'input') {
        const trimmed = rejectDraft.trim()
        if (!trimmed) return true
        toolUseConfirm.onReject(trimmed)
        onDone()
        return true
      }

      if (focusedOption && 'value' in focusedOption) {
        handleApprove(focusedOption.value)
        return true
      }
    }

    if (focusSection === 'options' && focusedOption?.type === 'input') {
      if (key.backspace || key.delete) {
        setRejectDraft(prev => prev.slice(0, -1))
        return true
      }

      if (key.paste || key.insertable) {
        if (input.length > 0) {
          setRejectDraft(prev => prev + input)
        }
        return true
      }
    }

    if (!(key.ctrl && input.toLowerCase() === 'g')) return undefined

    void openPlanInEditor()
    return true
  })

  if (remoteExitState === 'checking') {
    return (
      <Box marginTop={1} width="100%">
        <ScreenFrame
          title="Pushing to remote…"
          titleColor={theme.planMode}
          paddingX={layout.paddingX}
          paddingY={layout.tightLayout ? 0 : layout.paddingY}
          gap={layout.gap}
        >
          <Box flexDirection="column" gap={layout.gap}>
            <Text>Checking prerequisites…</Text>
            <Text dimColor wrap="truncate-end">
              Esc to go back
            </Text>
          </Box>
        </ScreenFrame>
      </Box>
    )
  }

  if (remoteExitState === 'unavailable') {
    return (
      <Box marginTop={1} width="100%">
        <ScreenFrame
          title="Push to remote unavailable"
          titleColor={theme.planMode}
          paddingX={layout.paddingX}
          paddingY={layout.tightLayout ? 0 : layout.paddingY}
          gap={layout.gap}
        >
          <Box flexDirection="column" gap={layout.gap}>
            <Text>{remoteExitMessage ?? 'Remote push is unavailable.'}</Text>
            <Text dimColor wrap="truncate-end">
              Esc to go back
            </Text>
          </Box>
        </ScreenFrame>
      </Box>
    )
  }

  if (showExitWithoutPlan) {
    const yesIsFocused = focusedOptionIndex === 0
    const noIsFocused = focusedOptionIndex === 1

    return (
      <Box marginTop={1} width="100%">
        <ScreenFrame
          title="Exit plan mode?"
          titleColor={theme.planMode}
          paddingX={layout.paddingX}
          paddingY={layout.tightLayout ? 0 : layout.paddingY}
          gap={layout.gap}
        >
          <Box flexDirection="column" gap={layout.gap}>
            <Text>{PRODUCT_NAME} wants to exit plan mode</Text>
            <Box flexDirection="column">
              <Box paddingLeft={2} paddingRight={1}>
                {yesIsFocused ? (
                  <Text color={theme.kode}>{figures.pointer}</Text>
                ) : null}
                <Text
                  bold={yesIsFocused}
                  color={yesIsFocused ? theme.kode : theme.text}
                >
                  Yes
                </Text>
              </Box>
              <Box paddingLeft={2} paddingRight={1}>
                {noIsFocused ? (
                  <Text color={theme.kode}>{figures.pointer}</Text>
                ) : null}
                <Text
                  bold={noIsFocused}
                  color={noIsFocused ? theme.kode : theme.text}
                >
                  No
                </Text>
              </Box>
            </Box>
            <Text dimColor wrap="truncate-end">
              Enter to confirm · Esc to exit
            </Text>
          </Box>
        </ScreenFrame>
      </Box>
    )
  }

  const topIndicator = planWindow.showUpIndicator
    ? `${figures.arrowUp} More`
    : ' '
  const bottomIndicator = planWindow.showDownIndicator
    ? `${figures.arrowDown} More`
    : ' '

  return (
    <Box marginTop={1} width="100%">
      <ScreenFrame
        title="Ready to code?"
        titleColor={theme.planMode}
        paddingX={layout.paddingX}
        paddingY={layout.tightLayout ? 0 : layout.paddingY}
        gap={layout.gap}
      >
        <Box flexDirection="column" gap={layout.gap}>
          <Box flexDirection="column">
            <Text dimColor wrap="truncate-end">
              Plan preview · PgUp/PgDn scroll
            </Text>
            <Box flexDirection="column" width="100%">
              <Text dimColor wrap="truncate-end">
                {topIndicator}
              </Text>
              {planLines
                .slice(planWindow.start, planWindow.end)
                .map((line, idx) => (
                  <Box key={`${planWindow.start + idx}`}>
                    <Text wrap="truncate-end">{line}</Text>
                  </Box>
                ))}
              <Text dimColor wrap="truncate-end">
                {bottomIndicator}
              </Text>
            </Box>
          </Box>

          {editorLabel ? (
            <Box flexDirection="row" gap={1}>
              <Box flexDirection="row">
                <Text dimColor wrap="truncate-end">
                  ctrl-g to edit in{' '}
                </Text>
                <Text bold dimColor wrap="truncate-end">
                  {editorLabel}
                </Text>
                <Text dimColor wrap="truncate-end">
                  {' · '}
                  {planFilePath}
                </Text>
              </Box>
              {planSaved ? (
                <Box flexDirection="row">
                  <Text dimColor> · </Text>
                  <Text color={theme.success}>{figures.tick} Plan saved!</Text>
                </Box>
              ) : null}
            </Box>
          ) : null}

          {editorStatus ? (
            <Text
              color={
                editorStatus.kind === 'error'
                  ? theme.error
                  : theme.secondaryText
              }
              wrap="truncate-end"
            >
              {editorStatus.message}
            </Text>
          ) : null}

          {allowedPrompts ? (
            <Box flexDirection="column">
              <Text bold>Requested permissions:</Text>
              <Box flexDirection="column" paddingLeft={2}>
                {allowedPrompts.map((prompt, idx) => {
                  const isFocused =
                    focusSection === 'permissions' &&
                    idx === focusedAllowedPromptIndex
                  const isSelected = selectedAllowedPromptIndices.includes(idx)
                  const checkbox = isSelected
                    ? figures.checkboxOn
                    : figures.checkboxOff

                  const rowColor =
                    focusSection === 'permissions'
                      ? isFocused
                        ? theme.kode
                        : theme.text
                      : theme.secondaryText

                  return (
                    <Box key={`${prompt.tool}-${idx}`} paddingRight={1}>
                      {isFocused ? (
                        <Text color={theme.kode}>{figures.pointer}</Text>
                      ) : (
                        <Text> </Text>
                      )}
                      <Text
                        color={rowColor}
                        bold={isFocused}
                        wrap="truncate-end"
                      >
                        {checkbox} {prompt.tool} {figures.arrowRight}{' '}
                        {prompt.prompt}
                      </Text>
                    </Box>
                  )
                })}
              </Box>
              <Text dimColor wrap="truncate-end">
                {focusSection === 'permissions'
                  ? `${figures.arrowDown} to proceed · Enter to toggle`
                  : `${figures.arrowUp} on first option to edit`}
              </Text>
            </Box>
          ) : null}

          <Box flexDirection="column">
            <Text dimColor>Would you like to proceed?</Text>
            <Box flexDirection="column">
              {options.map((option, idx) => {
                const isFocused =
                  focusSection === 'options' && idx === focusedOptionIndex

                if (option.type === 'input') {
                  const placeholder = option.placeholder
                  const suffix =
                    rejectDraft.length > 0 ? rejectDraft : placeholder
                  const suffixColor =
                    rejectDraft.length > 0 ? theme.text : theme.secondaryText

                  return (
                    <Box key={option.value} paddingLeft={2} paddingRight={1}>
                      {isFocused ? (
                        <Text color={theme.kode}>{figures.pointer}</Text>
                      ) : null}
                      <Text
                        bold={isFocused}
                        color={
                          isFocused
                            ? theme.kode
                            : focusSection === 'permissions'
                              ? theme.secondaryText
                              : theme.text
                        }
                        wrap="truncate-end"
                      >
                        {option.label}
                      </Text>
                      <Text dimColor> {figures.arrowRight} </Text>
                      <Text color={suffixColor} wrap="truncate-end">
                        {suffix}
                      </Text>
                    </Box>
                  )
                }

                return (
                  <Box key={option.value} paddingLeft={2} paddingRight={1}>
                    {isFocused ? (
                      <Text color={theme.kode}>{figures.pointer}</Text>
                    ) : null}
                    <Text
                      bold={isFocused}
                      color={
                        isFocused
                          ? theme.kode
                          : focusSection === 'permissions'
                            ? theme.secondaryText
                            : theme.text
                      }
                      wrap="truncate-end"
                    >
                      {option.label}
                    </Text>
                  </Box>
                )
              })}
            </Box>
          </Box>

          <Text dimColor wrap="truncate-end">
            {focusSection === 'permissions'
              ? 'Enter to toggle · Esc to exit'
              : `Enter to confirm · Esc to exit · ${modeCycleShortcut.displayText} quick select`}
          </Text>
        </Box>
      </ScreenFrame>
    </Box>
  )
}
