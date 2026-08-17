import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text } from 'ink'

import {
  getBackgroundTaskOutputFilePath,
  killBackgroundTask,
  listBackgroundTaskSnapshots,
  readBackgroundTaskOutputTailLines,
  type BackgroundAgentTaskSnapshot,
  type BackgroundShellTaskSnapshot,
  type BackgroundTaskSnapshot,
  type BackgroundTaskStatus,
} from '#core/tasks/backgroundRegistry'
import { getOriginalCwd } from '#core/utils/state'
import { getTheme } from '#core/utils/theme'
import { getKodeAgentSessionId } from '#protocol/utils/kodeAgentSessionId'
import { getAgentLogFilePath } from '#protocol/utils/kodeAgentSessionLog'
import { launchExternalEditorForFilePath } from '#cli-utils/externalEditor'
import { useKeypress } from '#ui-ink/hooks/useKeypress'
import { KEYPRESS_PRIORITY } from '#ui-ink/constants/keypressPriority'
import { ScreenFrame } from '#ui-ink/primitives/layout/ScreenFrame'
import { useScreenLayout } from '#ui-ink/primitives/layout/useScreenLayout'
import { useScopedIndexState } from '#ui-ink/hooks/useScopedIndexState'

const VIEWPORT_SAFE_MARGIN_ROWS = 1
const INDICATOR_ROWS = 2
const REFRESH_INTERVAL_MS = 1000

type TaskFilter = 'all' | 'active' | 'finished'

type TreeNode =
  | {
      kind: 'group'
      id: string
      label: string
      status: BackgroundTaskStatus | null
      children: TreeNode[]
    }
  | {
      kind: 'agent'
      task: BackgroundAgentTaskSnapshot
      children: TreeNode[]
    }
  | {
      kind: 'shell'
      task: BackgroundShellTaskSnapshot
    }

type FlatItem =
  | {
      kind: 'group'
      id: string
      depth: number
      label: string
      status: BackgroundTaskStatus | null
      hasChildren: boolean
    }
  | {
      kind: 'agent'
      id: string
      depth: number
      task: BackgroundAgentTaskSnapshot
      hasChildren: boolean
    }
  | {
      kind: 'shell'
      id: string
      depth: number
      task: BackgroundShellTaskSnapshot
    }

type DetailTarget = { kind: 'shell' | 'agent'; id: string }

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function firstLine(text: string, maxLen: number): string {
  const line = text.split(/\r?\n/)[0] ?? ''
  const trimmed = line.trim()
  if (trimmed.length <= maxLen) return trimmed
  return trimmed.slice(0, maxLen - 1) + '…'
}

function formatRuntime(startedAt: number, completedAt?: number): string {
  const end = completedAt ?? Date.now()
  const deltaSeconds = Math.max(0, Math.floor((end - startedAt) / 1000))
  const hours = Math.floor(deltaSeconds / 3600)
  const minutes = Math.floor((deltaSeconds - hours * 3600) / 60)
  const seconds = deltaSeconds - hours * 3600 - minutes * 60
  return `${hours > 0 ? `${hours}h ` : ''}${minutes > 0 || hours > 0 ? `${minutes}m ` : ''}${seconds}s`
}

function rankStatus(status: BackgroundTaskStatus): number {
  switch (status) {
    case 'running':
      return 0
    case 'failed':
      return 1
    case 'killed':
      return 2
    case 'completed':
      return 3
    default:
      return 4
  }
}

function aggregateStatus(
  statuses: BackgroundTaskStatus[],
): BackgroundTaskStatus | null {
  if (statuses.length === 0) return null
  return (
    statuses.slice().sort((a, b) => rankStatus(a) - rankStatus(b))[0] ?? null
  )
}

function statusLabel(status: BackgroundTaskStatus | null): string {
  return status ?? 'idle'
}

function statusIcon(status: BackgroundTaskStatus | null): string {
  switch (status) {
    case 'running':
      return '●'
    case 'completed':
      return '✓'
    case 'failed':
      return '✗'
    case 'killed':
      return '⨯'
    default:
      return '·'
  }
}

function isAgentTaskSnapshot(
  task: BackgroundTaskSnapshot,
): task is BackgroundAgentTaskSnapshot {
  return task.taskType === 'local_agent'
}

function isShellTaskSnapshot(
  task: BackgroundTaskSnapshot,
): task is BackgroundShellTaskSnapshot {
  return task.taskType === 'local_bash'
}

export function __filterTaskSnapshotsForTests(
  tasks: readonly BackgroundTaskSnapshot[],
  filter: TaskFilter,
): BackgroundTaskSnapshot[] {
  if (filter === 'all') return [...tasks]
  if (filter === 'active') {
    return tasks.filter(
      task => task.status === 'running' || task.status === 'pending',
    )
  }
  return tasks.filter(
    task =>
      task.status === 'completed' ||
      task.status === 'failed' ||
      task.status === 'killed',
  )
}

export function __nextTaskFilterForTests(filter: TaskFilter): TaskFilter {
  if (filter === 'all') return 'active'
  if (filter === 'active') return 'finished'
  return 'all'
}

function taskFilterLabel(filter: TaskFilter): string {
  return filter
}

function buildAgentTree(tasks: BackgroundAgentTaskSnapshot[]): TreeNode | null {
  if (tasks.length === 0) return null

  const byId = new Map<string, BackgroundAgentTaskSnapshot>()
  for (const task of tasks) byId.set(task.taskId, task)

  const childrenByParent = new Map<string, BackgroundAgentTaskSnapshot[]>()
  for (const task of tasks) {
    const rawParent = task.parentTaskId
    const effectiveParent =
      !rawParent || rawParent === 'main' || !byId.has(rawParent)
        ? 'main'
        : rawParent
    const list = childrenByParent.get(effectiveParent) ?? []
    list.push(task)
    childrenByParent.set(effectiveParent, list)
  }

  for (const list of childrenByParent.values()) {
    list.sort((a, b) => a.startedAt - b.startedAt)
  }

  const visited = new Set<string>()
  const buildChildren = (parentId: string): TreeNode[] => {
    const children = childrenByParent.get(parentId) ?? []
    const out: TreeNode[] = []
    for (const child of children) {
      if (visited.has(child.taskId)) continue
      visited.add(child.taskId)
      const grand = buildChildren(child.taskId)
      out.push({ kind: 'agent', task: child, children: grand })
    }
    return out
  }

  const mainChildren = buildChildren('main')
  const mainStatus = aggregateStatus(
    mainChildren.flatMap(node =>
      node.kind === 'agent' ? [node.task.status] : [],
    ),
  )

  return {
    kind: 'group',
    id: 'main',
    label: 'main',
    status: mainStatus,
    children: mainChildren,
  }
}

function buildTasksTree(args: {
  agentTasks: BackgroundAgentTaskSnapshot[]
  shellTasks: BackgroundShellTaskSnapshot[]
}): TreeNode[] {
  const out: TreeNode[] = []

  const agentRoot = buildAgentTree(args.agentTasks)
  if (agentRoot) out.push(agentRoot)

  if (args.shellTasks.length > 0) {
    const status = aggregateStatus(args.shellTasks.map(t => t.status))
    out.push({
      kind: 'group',
      id: '__shell__',
      label: 'shell',
      status,
      children: args.shellTasks
        .slice()
        .sort((a, b) => rankStatus(a.status) - rankStatus(b.status))
        .map(t => ({ kind: 'shell', task: t })),
    })
  }

  return out
}

export function __flattenTasksTreeForTests(args: {
  nodes: TreeNode[]
  collapsedIds: Set<string>
}): FlatItem[] {
  const out: FlatItem[] = []

  const walk = (node: TreeNode, depth: number) => {
    if (node.kind === 'group') {
      const hasChildren = node.children.length > 0
      out.push({
        kind: 'group',
        id: node.id,
        depth,
        label: node.label,
        status: node.status,
        hasChildren,
      })
      if (hasChildren && !args.collapsedIds.has(node.id)) {
        for (const child of node.children) walk(child, depth + 1)
      }
      return
    }

    if (node.kind === 'agent') {
      const hasChildren = node.children.length > 0
      out.push({
        kind: 'agent',
        id: node.task.taskId,
        depth,
        task: node.task,
        hasChildren,
      })
      if (hasChildren && !args.collapsedIds.has(node.task.taskId)) {
        for (const child of node.children) walk(child, depth + 1)
      }
      return
    }

    out.push({ kind: 'shell', id: node.task.taskId, depth, task: node.task })
  }

  for (const node of args.nodes) walk(node, 0)
  return out
}

export function __buildFlatLinesForTests(args: {
  items: FlatItem[]
  selectedIndex: number
  collapsedIds: Set<string>
  maxWidth: number
}): Array<{
  key: string
  isSelected: boolean
  status: BackgroundTaskStatus | null
  text: string
}> {
  const out: Array<{
    key: string
    isSelected: boolean
    status: BackgroundTaskStatus | null
    text: string
  }> = []

  const indentFor = (depth: number) => '  '.repeat(Math.max(0, depth))

  for (let i = 0; i < args.items.length; i++) {
    const item = args.items[i]!
    const isSelected = i === args.selectedIndex

    if (item.kind === 'group') {
      const caret = item.hasChildren
        ? args.collapsedIds.has(item.id)
          ? '▸'
          : '▾'
        : ' '
      const label = `${caret} ${statusIcon(item.status)} ${item.label} (${statusLabel(item.status)})`
      out.push({
        key: `group:${item.id}`,
        isSelected,
        status: item.status,
        text: `${indentFor(item.depth)}${label}`,
      })
      continue
    }

    if (item.kind === 'shell') {
      const label = `${statusIcon(item.task.status)} ${firstLine(item.task.command, 90)}`
      out.push({
        key: `shell:${item.task.taskId}`,
        isSelected,
        status: item.task.status,
        text: `${indentFor(item.depth)}${label}`,
      })
      continue
    }

    const caret = item.hasChildren
      ? args.collapsedIds.has(item.task.taskId)
        ? '▸'
        : '▾'
      : ' '

    const status = item.task.status
    const errorHint =
      status === 'failed' && item.task.error
        ? ` — ${firstLine(item.task.error, 80)}`
        : ''
    const label = `${caret} ${statusIcon(status)} ${firstLine(item.task.description, 90)}${errorHint}`

    out.push({
      key: `agent:${item.task.taskId}`,
      isSelected,
      status,
      text: `${indentFor(item.depth)}${label}`,
    })
  }

  // truncate for safety
  return out.map(row => ({
    ...row,
    text:
      row.text.length > args.maxWidth
        ? row.text.slice(0, args.maxWidth - 1) + '…'
        : row.text,
  }))
}

function isRunningLeaf(item: FlatItem): boolean {
  if (item.kind === 'agent') return item.task.status === 'running'
  if (item.kind === 'shell') return item.task.status === 'running'
  return false
}

export function __getPreferredSelectedIndexForTests(args: {
  items: FlatItem[]
  currentIndex: number
}): number {
  const leafIndices: number[] = []
  const runningLeafIndices: number[] = []

  for (let i = 0; i < args.items.length; i++) {
    const item = args.items[i]!
    if (item.kind === 'group') continue
    leafIndices.push(i)
    if (isRunningLeaf(item)) runningLeafIndices.push(i)
  }

  if (leafIndices.length === 0) return 0
  if (leafIndices.length === 1) return leafIndices[0]!
  if (runningLeafIndices.length === 1) return runningLeafIndices[0]!
  if (args.currentIndex === 0 && runningLeafIndices.length > 0) {
    return runningLeafIndices[0]!
  }

  return args.currentIndex
}

export function TasksScreen({
  onDone,
}: {
  onDone: (result?: string) => void
}): React.ReactNode {
  const theme = getTheme()
  const layout = useScreenLayout()
  const exitState = { pending: false, keyName: null as null } as const
  const didDoneRef = useRef(false)

  const safeOnDone = useCallback(
    (result?: string) => {
      if (didDoneRef.current) return
      didDoneRef.current = true
      onDone(result)
    },
    [onDone],
  )

  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set())
  const [status, setStatus] = useState<string | null>(null)
  // 'k' kills without confirmation in other overlays? No — in Tasks, 'k' is
  // the kill key, which collides with the j/k navigation convention used by
  // every other overlay. Killing stays on 'k' but requires a second press on
  // the same task (armed state) so a stray navigation key cannot kill.
  const [confirmKillId, setConfirmKillId] = useState<string | null>(null)
  const confirmKillTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  const [scrollTop, setScrollTop] = useState(0)
  const [detailTarget, setDetailTarget] = useState<DetailTarget | null>(null)
  const [taskFilter, setTaskFilter] = useState<TaskFilter>('all')
  const userMovedSelectionRef = useRef(false)
  const isOpeningFileRef = useRef(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      isOpeningFileRef.current = false
    }
  }, [])

  const [tick, setTick] = useState(0)
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), REFRESH_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [])

  const refresh = useCallback(() => {
    setTick(t => t + 1)
    setStatus('Refreshed')
  }, [])

  const cycleTaskFilter = useCallback(() => {
    setTaskFilter(current => __nextTaskFilterForTests(current))
    setScrollTop(0)
    setStatus(null)
  }, [])

  const allTasks = useMemo(() => {
    void tick
    return listBackgroundTaskSnapshots()
  }, [tick])
  const tasks = useMemo(
    () => __filterTaskSnapshotsForTests(allTasks, taskFilter),
    [allTasks, taskFilter],
  )
  const { agentTasks, shellTasks } = useMemo(() => {
    return {
      agentTasks: tasks.filter(isAgentTaskSnapshot),
      shellTasks: tasks.filter(isShellTaskSnapshot),
    }
  }, [tasks])

  const nodes = useMemo(
    () =>
      buildTasksTree({
        agentTasks,
        shellTasks,
      }),
    [agentTasks, shellTasks],
  )

  const flatItems = useMemo(
    () =>
      __flattenTasksTreeForTests({
        nodes,
        collapsedIds,
      }),
    [collapsedIds, nodes],
  )
  const [selectedIndex, setSelectedIndex] = useScopedIndexState({
    scope: 'tasks-screen:list',
    itemCount: flatItems.length,
  })

  const frameHeaderRows = 1
  const frameRows = frameHeaderRows + 1 + layout.gap * 2 + layout.paddingY * 2
  const detailRows = layout.tightLayout ? 2 : 3
  const innerReservedRows =
    1 + // description
    1 + // shortcut line
    detailRows +
    1 + // status line
    1 + // tip line
    INDICATOR_ROWS

  const contentRows = Math.max(
    1,
    layout.rows - frameRows - innerReservedRows - VIEWPORT_SAFE_MARGIN_ROWS,
  )

  useEffect(() => {
    setSelectedIndex(prev => clamp(prev, 0, Math.max(0, flatItems.length - 1)))
  }, [flatItems.length, setSelectedIndex])

  useEffect(() => {
    setSelectedIndex(prev => {
      if (userMovedSelectionRef.current) return prev
      const preferred = __getPreferredSelectedIndexForTests({
        items: flatItems,
        currentIndex: prev,
      })
      return clamp(preferred, 0, Math.max(0, flatItems.length - 1))
    })
  }, [flatItems, setSelectedIndex])

  useEffect(() => {
    setScrollTop(prev => {
      const maxScrollTop = Math.max(0, flatItems.length - contentRows)
      const target = clamp(prev, 0, maxScrollTop)
      if (selectedIndex < target) return selectedIndex
      if (selectedIndex >= target + contentRows) {
        return clamp(selectedIndex - contentRows + 1, 0, maxScrollTop)
      }
      return target
    })
  }, [contentRows, flatItems.length, selectedIndex])

  const toggleCollapse = useCallback((id: string) => {
    setCollapsedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const selected = flatItems[selectedIndex] ?? null

  const detailTask = useMemo(() => {
    if (!detailTarget) return null
    if (detailTarget.kind === 'shell') {
      return shellTasks.find(t => t.taskId === detailTarget.id) ?? null
    }
    return agentTasks.find(t => t.taskId === detailTarget.id) ?? null
  }, [agentTasks, detailTarget, shellTasks])

  const detailOutputLines = useMemo(() => {
    void tick
    if (!detailTarget) return []
    return readBackgroundTaskOutputTailLines(detailTarget.id, 10)
  }, [detailTarget, tick])

  const openDetails = useCallback(() => {
    if (!selected || selected.kind === 'group') return
    setDetailTarget({ kind: selected.kind, id: selected.id })
  }, [selected])

  const openExternalFile = useCallback(
    async ({ path, label }: { path: string; label: 'output' | 'log' }) => {
      if (isOpeningFileRef.current) return

      isOpeningFileRef.current = true
      setStatus(`Opening ${label} in external editor…`)

      try {
        const result = await launchExternalEditorForFilePath(path)
        if (!mountedRef.current) return

        if (result.ok === true) {
          setStatus(`Opened ${label} in ${result.editorLabel}`)
        } else {
          setStatus(result.error.message || `Failed to open ${label} file`)
        }
      } catch {
        if (mountedRef.current) {
          setStatus(
            'Unable to open the external editor. Check $EDITOR and try again.',
          )
        }
      } finally {
        isOpeningFileRef.current = false
      }
    },
    [],
  )

  const openOutput = useCallback(async () => {
    if (!selected || selected.kind === 'group') return

    await openExternalFile({
      path: getBackgroundTaskOutputFilePath(selected.id),
      label: 'output',
    })
  }, [openExternalFile, selected])

  const openLog = useCallback(async () => {
    if (!selected || selected.kind !== 'agent') return

    await openExternalFile({
      path: getAgentLogFilePath({
        cwd: getOriginalCwd(),
        sessionId: getKodeAgentSessionId(),
        agentId: selected.id,
      }),
      label: 'log',
    })
  }, [openExternalFile, selected])

  const killSelected = useCallback(() => {
    if (!selected || selected.kind === 'group') return

    if (confirmKillId !== selected.id) {
      setConfirmKillId(selected.id)
      setStatus(`Press k again to kill task: ${selected.id}`)
      if (confirmKillTimeoutRef.current) {
        clearTimeout(confirmKillTimeoutRef.current)
      }
      confirmKillTimeoutRef.current = setTimeout(() => {
        confirmKillTimeoutRef.current = null
        setConfirmKillId(null)
        setStatus(null)
      }, 5000)
      return
    }

    if (confirmKillTimeoutRef.current) {
      clearTimeout(confirmKillTimeoutRef.current)
      confirmKillTimeoutRef.current = null
    }
    setConfirmKillId(null)
    const killed = killBackgroundTask(selected.id)
    setStatus(killed ? `Killed task: ${selected.id}` : 'Task not running')
  }, [confirmKillId, selected])

  const killDetailTask = useCallback(() => {
    if (!detailTarget) return

    if (confirmKillId !== detailTarget.id) {
      setConfirmKillId(detailTarget.id)
      setStatus(`Press k again to kill task: ${detailTarget.id}`)
      if (confirmKillTimeoutRef.current) {
        clearTimeout(confirmKillTimeoutRef.current)
      }
      confirmKillTimeoutRef.current = setTimeout(() => {
        confirmKillTimeoutRef.current = null
        setConfirmKillId(null)
        setStatus(null)
      }, 5000)
      return
    }

    if (confirmKillTimeoutRef.current) {
      clearTimeout(confirmKillTimeoutRef.current)
      confirmKillTimeoutRef.current = null
    }
    setConfirmKillId(null)
    const killed = killBackgroundTask(detailTarget.id)
    setStatus(killed ? `Killed task: ${detailTarget.id}` : 'Task not running')
  }, [confirmKillId, detailTarget])

  useKeypress(
    (input, key) => {
      if (detailTarget) {
        if (key.leftArrow) {
          setDetailTarget(null)
          return true
        }

        if (input === 'k') {
          killDetailTask()
          return true
        }

        if (
          key.escape ||
          key.return ||
          input === ' ' ||
          (key.ctrl && input === 'c')
        ) {
          safeOnDone()
          return true
        }

        return undefined
      }

      if (key.escape || (key.ctrl && input === 'c')) {
        safeOnDone()
        return true
      }

      if (key.upArrow) {
        userMovedSelectionRef.current = true
        setSelectedIndex(prev =>
          clamp(prev - 1, 0, Math.max(0, flatItems.length - 1)),
        )
        return true
      }

      if (key.downArrow) {
        userMovedSelectionRef.current = true
        setSelectedIndex(prev =>
          clamp(prev + 1, 0, Math.max(0, flatItems.length - 1)),
        )
        return true
      }

      if (key.leftArrow) {
        if (!selected) return true
        const id =
          selected.kind === 'agent'
            ? selected.id
            : selected.kind === 'group'
              ? selected.id
              : null
        if (id && !collapsedIds.has(id)) toggleCollapse(id)
        return true
      }

      if (key.rightArrow) {
        if (!selected) return true
        const id =
          selected.kind === 'agent'
            ? selected.id
            : selected.kind === 'group'
              ? selected.id
              : null
        if (id && collapsedIds.has(id)) toggleCollapse(id)
        return true
      }

      if (key.return) {
        if (!selected) return true
        if (selected.kind === 'shell' || selected.kind === 'agent') {
          openDetails()
          return true
        }
        if (selected.kind === 'group') {
          toggleCollapse(selected.id)
          return true
        }
        return true
      }

      if (input === ' ') {
        if (!selected) return true
        const id =
          selected.kind === 'agent'
            ? selected.id
            : selected.kind === 'group'
              ? selected.id
              : null
        if (id) toggleCollapse(id)
        return true
      }

      if (input === 'r') {
        refresh()
        return true
      }

      if (input === 'f') {
        cycleTaskFilter()
        return true
      }

      if (input === 'k') {
        killSelected()
        return true
      }

      if (input === 'o') {
        void openOutput()
        return true
      }

      if (input === 'l') {
        void openLog()
        return true
      }

      return undefined
    },
    { priority: KEYPRESS_PRIORITY.FULLSCREEN_OVERLAY },
  )

  const hiddenAbove = scrollTop
  const hiddenBelow = Math.max(0, flatItems.length - (scrollTop + contentRows))
  const topIndicator = hiddenAbove ? `... ${hiddenAbove} hidden ...` : ''
  const bottomIndicator = hiddenBelow ? `... ${hiddenBelow} hidden ...` : ''

  const width = Math.max(1, layout.columns - layout.paddingX * 2)
  const visible = useMemo(
    () =>
      __buildFlatLinesForTests({
        items: flatItems.slice(scrollTop, scrollTop + contentRows),
        selectedIndex: selectedIndex - scrollTop,
        collapsedIds,
        maxWidth: width,
      }),
    [collapsedIds, contentRows, flatItems, scrollTop, selectedIndex, width],
  )

  const shortcutLine =
    '↑/↓ select · ←/→ collapse · Enter view · f filter · k kill (twice) · o output · l log · Esc close'

  const detailLines: string[] = []
  if (!selected) {
    detailLines.push('No background tasks')
  } else if (selected.kind === 'group') {
    detailLines.push(`${selected.label} (${statusLabel(selected.status)})`)
  } else if (selected.kind === 'shell') {
    detailLines.push(`Shell: ${selected.id} (${selected.task.status})`)
    detailLines.push(`output: ${getBackgroundTaskOutputFilePath(selected.id)}`)
  } else {
    detailLines.push(`Agent: ${selected.id} (${selected.task.status})`)
    detailLines.push(`output: ${getBackgroundTaskOutputFilePath(selected.id)}`)
    if (!layout.tightLayout) {
      detailLines.push(
        `log: ${getAgentLogFilePath({
          cwd: getOriginalCwd(),
          sessionId: getKodeAgentSessionId(),
          agentId: selected.id,
        })}`,
      )
    }
  }

  const totalTasks = tasks.length
  const runningTasks = allTasks.filter(t => t.status === 'running').length

  const statusLine =
    status ??
    (totalTasks > 0
      ? `Local tasks: ${taskFilterLabel(taskFilter)} · ${runningTasks} running · ${totalTasks} shown`
      : `No ${taskFilterLabel(taskFilter)} local tasks`)

  const tipLine =
    'Local task snapshots end with this Kode process. Use /runs status for durable-run records.'

  if (detailTarget) {
    const outputFile =
      detailTask?.outputFile ?? getBackgroundTaskOutputFilePath(detailTarget.id)

    const runtime =
      detailTask !== null
        ? formatRuntime(detailTask.startedAt, detailTask.completedAt)
        : null

    const commandOrDescription =
      detailTask?.taskType === 'local_bash'
        ? detailTask.command
        : detailTask?.description

    const totalLines =
      detailTask?.taskType === 'local_bash'
        ? detailTask.stdoutLineCount +
          detailTask.stderrLineCount +
          (detailOutputLines.length > 0 ? 1 : 0)
        : null

    const showingLine =
      detailOutputLines.length === 0
        ? null
        : totalLines !== null && totalLines > 10
          ? `Showing last 10 lines of ${totalLines} total. Full output: ${outputFile}`
          : totalLines !== null
            ? `Showing ${totalLines} lines`
            : `Full output: ${outputFile}`

    const footerActions = [
      '← to go back',
      'Esc/Enter/Space to close',
      detailTask?.status === 'running' ? 'k to kill' : null,
    ]
      .filter(Boolean)
      .join(' · ')

    return (
      <ScreenFrame
        title={detailTarget.kind === 'shell' ? 'Shell details' : 'Task details'}
        exitState={exitState}
        paddingX={layout.paddingX}
        paddingY={layout.paddingY}
        gap={layout.gap}
      >
        <Box flexDirection="column">
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={theme.secondaryBorder}
            paddingX={1}
          >
            <Text color={theme.text} wrap="truncate-end">
              <Text bold>Status</Text>: {detailTask?.status ?? '(unknown)'}
            </Text>
            {runtime ? (
              <Text color={theme.text} wrap="truncate-end">
                <Text bold>Runtime</Text>: {runtime}
              </Text>
            ) : null}
            <Text color={theme.text} wrap="truncate-end">
              <Text bold>
                {detailTarget.kind === 'shell' ? 'Command' : 'Task'}
              </Text>
              : {commandOrDescription ?? '(unknown)'}
            </Text>

            <Box flexDirection="column" marginTop={1}>
              <Text bold color={theme.text}>
                Output:
              </Text>
              {detailOutputLines.length > 0 ? (
                <Box
                  flexDirection="column"
                  borderStyle="round"
                  borderColor={theme.secondaryBorder}
                  paddingX={1}
                  height={12}
                  width="100%"
                >
                  {detailOutputLines.map((line, index) => (
                    <Text key={index} color={theme.text} wrap="truncate-end">
                      {line}
                    </Text>
                  ))}
                </Box>
              ) : (
                <Text color={theme.secondaryText}>No output available</Text>
              )}
              {showingLine ? (
                <Text color={theme.secondaryText} italic wrap="truncate-end">
                  {showingLine}
                </Text>
              ) : null}
            </Box>
          </Box>

          <Box marginLeft={2} marginTop={layout.gap}>
            <Text color={theme.secondaryText} wrap="truncate-end">
              {footerActions}
            </Text>
          </Box>
        </Box>
      </ScreenFrame>
    )
  }

  return (
    <ScreenFrame
      title="Local Tasks"
      exitState={exitState}
      paddingX={layout.paddingX}
      paddingY={layout.paddingY}
      gap={layout.gap}
    >
      <Box flexDirection="column">
        <Text color={theme.secondaryText} wrap="truncate-end">
          Inspect local background agents and shells; finished status is local,
          not remote success.
        </Text>
        <Text color={theme.secondaryText} wrap="truncate-end">
          {shortcutLine}
        </Text>

        <Box flexDirection="column" marginTop={layout.gap}>
          <Text color={theme.secondaryText} wrap="truncate-end">
            {topIndicator}
          </Text>
          {visible.length > 0 ? (
            visible.map(row => (
              <Text
                key={row.key}
                color={
                  row.isSelected
                    ? theme.text
                    : row.status === 'failed'
                      ? theme.error
                      : row.status === 'running'
                        ? theme.warning
                        : theme.secondaryText
                }
                wrap="truncate-end"
              >
                {row.isSelected ? `> ${row.text}` : `  ${row.text}`}
              </Text>
            ))
          ) : (
            <Text color={theme.secondaryText} wrap="truncate-end">
              (No matching local tasks)
            </Text>
          )}
          <Text color={theme.secondaryText} wrap="truncate-end">
            {bottomIndicator}
          </Text>
        </Box>

        <Box flexDirection="column" marginTop={layout.gap}>
          {detailLines.slice(0, detailRows).map((line, idx) => (
            <Text key={idx} color={theme.secondaryText} wrap="truncate-end">
              {line}
            </Text>
          ))}
        </Box>

        <Box flexDirection="column" marginTop={layout.gap}>
          <Text color={theme.secondaryText} wrap="truncate-end">
            {statusLine}
          </Text>
          <Text color={theme.secondaryText} wrap="truncate-end">
            {tipLine}
          </Text>
        </Box>
      </Box>
    </ScreenFrame>
  )
}
