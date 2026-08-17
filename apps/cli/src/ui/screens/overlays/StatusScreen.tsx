import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text } from 'ink'
import figures from 'figures'

import { MACRO } from '#core/constants/macros'
import type { ToolUseContext } from '#core/tooling/Tool'
import { getDisableAllHooksState } from '@kode/hooks/disableAllHooks'
import { getModelManager } from '#core/utils/model'
import { getTheme } from '#core/utils/theme'
import type { PermissionMode } from '#core/types/PermissionMode'
import { getPermissionModeStatusLabel } from '#ui-ink/utils/permissionModeDisplay'
import { getCwd } from '#core/utils/state'
import { getKodeAgentSessionId } from '#protocol/utils/kodeAgentSessionId'
import { useKeypress } from '#ui-ink/hooks/useKeypress'
import { KEYPRESS_PRIORITY } from '#ui-ink/constants/keypressPriority'
import { ScreenFrame } from '#ui-ink/primitives/layout/ScreenFrame'
import { useScreenLayout } from '#ui-ink/primitives/layout/useScreenLayout'
import {
  computeAvailableRows,
  computeScreenFrameReservedRows,
} from '#ui-ink/primitives/layout/viewportRows'
import { wrapLines } from '#ui-ink/primitives/text/wrapLines'
import type { ConnectionTestResult } from '#ui-ink/components/ModelSelector/flow/actions/connectionTest'
import { performConnectionTest } from '#ui-ink/components/ModelSelector/flow/actions/connectionTest'
import { formatContextLimit } from '#ui-ink/utils/tokenDisplay'

type Props = {
  context: ToolUseContext
  onDone: (result?: string) => void
}

type TabId = 'Status' | 'Models' | 'Tools' | 'MCP'

const TAB_ORDER: readonly TabId[] = ['Status', 'Models', 'Tools', 'MCP']

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function formatConnectivity(result: ConnectionTestResult | null): string {
  if (!result) return 'not tested'
  if (result.success) return `ok (${result.endpoint ?? 'unknown endpoint'})`
  const detail = result.errorCategory ? ` ${result.errorCategory}` : ''
  return `failed${detail}`
}

function buildStatusLines(args: {
  context: ToolUseContext
  connectivity: ConnectionTestResult | null
}): string[] {
  const cwd = getCwd()
  const hooks = getDisableAllHooksState({ projectDir: cwd })

  const tools = args.context.options?.tools ?? []
  const commands = args.context.options?.commands ?? []
  const mcpClients = args.context.options?.mcpClients ?? []

  const connectedMcp = mcpClients.filter((c: any) => c?.type === 'connected')
  const failedMcp = mcpClients.filter((c: any) => c?.type !== 'connected')

  const rawPermissionMode = args.context.options?.permissionMode
  const permissionMode =
    typeof rawPermissionMode === 'string'
      ? getPermissionModeStatusLabel(rawPermissionMode as PermissionMode)
      : getPermissionModeStatusLabel('cautious')

  const lines: string[] = []
  lines.push('Session')
  lines.push(`- version: ${MACRO.VERSION || '(unknown)'}`)
  lines.push(`- session_id: ${getKodeAgentSessionId()}`)
  lines.push(`- cwd: ${cwd}`)
  lines.push(`- safe_mode: ${args.context.safeMode ? 'on' : 'off'}`)
  lines.push(`- permission policy: ${permissionMode}`)

  lines.push('')
  lines.push('Connectivity')
  lines.push(`- api: ${formatConnectivity(args.connectivity)}`)

  lines.push('')
  lines.push('Hooks')
  lines.push(
    `- disableAllHooks: ${hooks.disabled ? 'true' : 'false'}${
      hooks.source ? ` (${hooks.source})` : ''
    }`,
  )

  lines.push('')
  lines.push('Tools')
  lines.push(`- tools: ${tools.length}`)
  lines.push(`- commands: ${commands.length}`)

  lines.push('')
  lines.push('MCP')
  lines.push(`- servers: ${mcpClients.length}`)
  lines.push(`- connected: ${connectedMcp.length}`)
  lines.push(`- failed: ${failedMcp.length}`)

  return lines
}

function buildModelsLines(): string[] {
  const modelManager = getModelManager()
  const pointers = ['main', 'task', 'compact', 'quick'] as const

  const lines: string[] = []
  lines.push('Model pointers')
  for (const pointer of pointers) {
    const profile = modelManager.getModel(pointer)
    if (!profile) {
      lines.push(`- ${pointer}: (not configured)`)
      continue
    }
    const provider = profile.provider ? ` (${profile.provider})` : ''
    const ctx = formatContextLimit(profile.contextLength) ?? 'unknown'
    const status = profile.isActive ? 'active' : 'inactive'
    lines.push(
      `- ${pointer}: ${profile.name}${provider} · ${profile.modelName} · ctx ${ctx} · ${status}`,
    )
  }

  return lines
}

function buildToolsLines(args: {
  context: ToolUseContext
  toolStatuses: Record<string, string>
  isCheckingTools: boolean
}): string[] {
  const tools = args.context.options?.tools ?? []
  const lines: string[] = []
  lines.push(`Tools (${tools.length})`)
  if (tools.length === 0) {
    lines.push('- (none)')
    return lines
  }
  if (args.isCheckingTools) {
    lines.push('- checking tool status…')
    lines.push('')
  }
  for (const tool of tools) {
    const name = String((tool as any)?.name ?? '')
    const status = args.toolStatuses[name] ?? 'unknown'
    lines.push(`- ${name}: ${status}`)
  }
  return lines
}

function buildMcpLines(context: ToolUseContext): string[] {
  const clients = (context.options?.mcpClients ?? []) as any[]
  const lines: string[] = []
  lines.push(`MCP servers (${clients.length})`)
  if (clients.length === 0) {
    lines.push('- (none)')
    return lines
  }
  for (const c of clients) {
    const name = typeof c?.name === 'string' ? c.name : '(unnamed)'
    const type = typeof c?.type === 'string' ? c.type : 'unknown'
    const info =
      c?.type === 'connected' && c?.serverInfo
        ? ` · ${String(c.serverInfo.name ?? '')} ${String(c.serverInfo.version ?? '')}`.trim()
        : c?.type === 'failed' && c?.error
          ? ` · ${String(c.error?.message ?? c.error)}`
          : ''
    lines.push(`- ${name}: ${type}${info}`)
  }
  return lines
}

export function StatusScreen({ context, onDone }: Props): React.ReactNode {
  const theme = getTheme()
  const layout = useScreenLayout()
  // Single Ctrl+C closes this read-only diagnostic screen, consistent with
  // the other overlays (double-press protection added no value here).
  const exitState = { pending: false, keyName: null as null } as const

  const [tabIndex, setTabIndex] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [connectivity, setConnectivity] = useState<ConnectionTestResult | null>(
    null,
  )
  const [isCheckingConnectivity, setIsCheckingConnectivity] = useState(false)
  const [isCheckingTools, setIsCheckingTools] = useState(false)
  const [toolStatuses, setToolStatuses] = useState<Record<string, string>>({})
  const isCheckingConnectivityRef = useRef(false)
  const connectivityCheckIdRef = useRef(0)
  const mountedRef = useRef(true)

  const tab = TAB_ORDER[Math.min(Math.max(0, tabIndex), TAB_ORDER.length - 1)]

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      connectivityCheckIdRef.current += 1
      isCheckingConnectivityRef.current = false
    }
  }, [])

  useEffect(() => {
    if (tab !== 'Tools') return undefined
    const tools = context.options?.tools ?? []
    if (tools.length === 0) return undefined
    let cancelled = false
    setIsCheckingTools(true)
    Promise.all(
      tools.map(async tool => {
        const name = String((tool as any)?.name ?? '')
        try {
          const enabled = await (tool as any)?.isEnabled?.()
          return [name, enabled === true ? 'enabled' : 'disabled'] as const
        } catch (err) {
          return [
            name,
            `error: ${err instanceof Error ? err.message : String(err)}`,
          ] as const
        }
      }),
    )
      .then(results => {
        if (cancelled) return
        setToolStatuses(Object.fromEntries(results))
      })
      .finally(() => {
        if (cancelled) return
        setIsCheckingTools(false)
      })
    return () => {
      cancelled = true
    }
  }, [context.options?.tools, tab])

  const tabLines = useMemo(() => {
    if (tab === 'Status') return buildStatusLines({ context, connectivity })
    if (tab === 'Models') return buildModelsLines()
    if (tab === 'Tools')
      return buildToolsLines({ context, toolStatuses, isCheckingTools })
    return buildMcpLines(context)
  }, [connectivity, context, isCheckingTools, tab, toolStatuses])

  const wrapped = useMemo(() => {
    const width = Math.max(1, layout.columns - layout.paddingX * 2)
    return wrapLines(tabLines, width)
  }, [layout.columns, layout.paddingX, tabLines])

  const frameRows = computeScreenFrameReservedRows({
    paddingY: layout.paddingY,
    gap: layout.gap,
    exitPromptRows: exitState.pending ? 1 : 0,
  })
  const contentRows = computeAvailableRows({
    rows: layout.rows,
    reservedRows: frameRows + 6,
    minRows: 1,
  })
  const maxScrollTop = Math.max(0, wrapped.length - contentRows)

  useKeypress(
    (input, key) => {
      const inputChar = input.length === 1 ? input : ''
      if (key.escape) {
        onDone('Status dialog dismissed')
        return true
      }
      if (key.ctrl && input === 'c') {
        onDone('Status dialog dismissed')
        return true
      }
      if (key.leftArrow || inputChar === 'h') {
        setTabIndex(prev => {
          const next = Math.max(0, prev - 1)
          if (next !== prev) setScrollTop(0)
          return next
        })
        return true
      }
      if (key.rightArrow || inputChar === 'l') {
        setTabIndex(prev => {
          const next = Math.min(TAB_ORDER.length - 1, prev + 1)
          if (next !== prev) setScrollTop(0)
          return next
        })
        return true
      }
      if ((inputChar === 'c' || inputChar === 'C') && tab === 'Status') {
        if (isCheckingConnectivityRef.current || isCheckingConnectivity)
          return true
        const model = getModelManager().getModel('main')
        if (!model) {
          setConnectivity({
            success: false,
            message: 'No model configured',
            details: 'Configure a model profile first',
          } as ConnectionTestResult)
          return true
        }
        const checkId = connectivityCheckIdRef.current + 1
        connectivityCheckIdRef.current = checkId
        const isCurrent = () =>
          mountedRef.current && connectivityCheckIdRef.current === checkId

        isCheckingConnectivityRef.current = true
        setIsCheckingConnectivity(true)
        const providerBaseUrl = model.baseURL ?? ''
        const customBaseUrl = model.baseURL ?? ''
        performConnectionTest(
          {
            selectedProvider: model.provider as any,
            selectedModel: model.modelName,
            apiKey: model.apiKey,
            maxTokens: String(model.maxTokens),
            providerBaseUrl,
            customBaseUrl,
            resourceName: '',
            requestStrategy: model.requestStrategy ?? 'auto',
          },
          {
            onProgress: result => {
              if (isCurrent()) setConnectivity(result)
            },
          },
        )
          .then(result => {
            if (isCurrent()) setConnectivity(result)
          })
          .finally(() => {
            if (connectivityCheckIdRef.current !== checkId) return
            isCheckingConnectivityRef.current = false
            if (mountedRef.current) setIsCheckingConnectivity(false)
          })
        return true
      }
      if (key.upArrow || inputChar === 'k') {
        setScrollTop(prev => clamp(prev - 1, 0, maxScrollTop))
        return true
      }
      if (key.downArrow || inputChar === 'j') {
        setScrollTop(prev => clamp(prev + 1, 0, maxScrollTop))
        return true
      }
      if (key.pageUp) {
        setScrollTop(prev => clamp(prev - contentRows, 0, maxScrollTop))
        return true
      }
      if (key.pageDown) {
        setScrollTop(prev => clamp(prev + contentRows, 0, maxScrollTop))
        return true
      }
      if (key.home || inputChar === 'g') {
        setScrollTop(0)
        return true
      }
      if (key.end || inputChar === 'G') {
        setScrollTop(maxScrollTop)
        return true
      }

      return undefined
    },
    { priority: KEYPRESS_PRIORITY.FULLSCREEN_OVERLAY },
  )

  const clampedScrollTop = clamp(scrollTop, 0, maxScrollTop)
  const hiddenAbove = clampedScrollTop
  const hiddenBelow = Math.max(
    0,
    wrapped.length - (clampedScrollTop + contentRows),
  )

  const visible = useMemo(
    () => wrapped.slice(clampedScrollTop, clampedScrollTop + contentRows),
    [clampedScrollTop, contentRows, wrapped],
  )

  const topIndicator = hiddenAbove
    ? `${figures.arrowUp} ${hiddenAbove} more`
    : ' '
  const bottomIndicator = hiddenBelow
    ? `${figures.arrowDown} ${hiddenBelow} more`
    : ' '

  const tabBar = (
    <Text wrap="truncate-end">
      {TAB_ORDER.map((id, idx) => {
        const active = idx === tabIndex
        return (
          <Text
            key={id}
            color={active ? theme.kode : theme.secondaryText}
            bold={active}
          >
            {active ? `[${id}]` : ` ${id} `}
          </Text>
        )
      })}
    </Text>
  )

  return (
    <ScreenFrame
      title="Status"
      exitState={exitState}
      paddingX={layout.paddingX}
      paddingY={layout.paddingY}
      gap={layout.gap}
    >
      <Box flexDirection="column">
        <Text dimColor wrap="truncate-end">
          Tabs: ←/→ h/l · c connectivity test · Scroll: ↑↓ j/k PgUp/PgDn
          Home/End · Esc close
        </Text>
        {tabBar}
        {tab === 'Status' && isCheckingConnectivity ? (
          <Text dimColor wrap="truncate-end">
            Checking connectivity…
          </Text>
        ) : null}
        <Text dimColor wrap="truncate-end">
          {topIndicator}
        </Text>
        {visible.length > 0 ? (
          visible.map((line, idx) => (
            <Text
              key={`${clampedScrollTop}:${idx}`}
              color={line.startsWith('- version:') ? theme.text : undefined}
              wrap="truncate-end"
            >
              {line}
            </Text>
          ))
        ) : (
          <Text dimColor>(empty)</Text>
        )}
        <Text dimColor wrap="truncate-end">
          {bottomIndicator}
        </Text>
      </Box>
    </ScreenFrame>
  )
}
