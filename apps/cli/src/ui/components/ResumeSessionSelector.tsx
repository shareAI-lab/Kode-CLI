import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Box, Text } from 'ink'
import figures from 'figures'
import { execFileSync } from 'node:child_process'
import { basename, resolve as resolvePath, sep } from 'node:path'
import { quote } from 'shell-quote'

import { PRODUCT_COMMAND } from '#core/constants/product'
import { queryLLM } from '#core/ai/llmLazy'
import { createUserMessage } from '@kode/engine/messages/create'
import { getTheme, type Theme } from '#core/utils/theme'
import { formatDate, logError } from '#core/utils/log'
import { getBranch } from '#core/utils/git'
import type { KodeAgentSessionListItem } from '#protocol/utils/kodeAgentSessionResume'
import {
  listAllKodeAgentSessions,
  listKodeAgentSessions,
} from '#protocol/utils/kodeAgentSessionResume'
import { appendSessionCustomTitleRecord } from '#protocol/utils/kodeAgentSessionLog'
import { loadKodeAgentSessionMessages } from '#protocol/utils/kodeAgentSessionLoad'
import { buildTranscriptLines } from '#cli-utils/transcriptText'
import { copyTextToClipboard } from '#cli-utils/clipboard'
import { useExitOnCtrlCD } from '#ui-ink/hooks/useExitOnCtrlCD'
import { useCliExit } from '#ui-ink/hooks/useCliExit'
import { useKeypress } from '#ui-ink/hooks/useKeypress'
import { KEYPRESS_PRIORITY } from '#ui-ink/constants/keypressPriority'
import { SearchBox } from '#ui-ink/components/SearchBox'
import TextInput from '#ui-ink/components/TextInput'
import { SimpleSpinner } from '#ui-ink/components/Spinner'
import { ScreenFrame } from '#ui-ink/primitives/layout/ScreenFrame'
import { useScreenLayout } from '#ui-ink/primitives/layout/useScreenLayout'
import { computeAvailableColumns } from '#ui-ink/primitives/layout/viewportColumns'
import { getWindowedList } from '#ui-ink/primitives/list/windowedList'
import { wrapLines } from '#ui-ink/primitives/text/wrapLines'
import { useScopedIndexState } from '#ui-ink/hooks/useScopedIndexState'
import { z } from 'zod'

type ViewMode = 'list' | 'search' | 'rename' | 'preview' | 'crossProject'

type SessionRow = {
  session: KodeAgentSessionListItem
  groupKey: string
  groupSize: number
  indexInGroup: number
  isGroupHeader: boolean
}

type ResumeSessionListProps = {
  visibleRowsList: SessionRow[]
  window: ReturnType<typeof getWindowedList>
  clampedSelection: number
  visibleRows: number
  theme: Theme
  expandedGroups: Set<string>
  showAllProjects: boolean
  showAllWorktrees: boolean
}

const ResumeSessionList = React.memo(function ResumeSessionList({
  visibleRowsList,
  window,
  clampedSelection,
  visibleRows,
  theme,
  expandedGroups,
  showAllProjects,
  showAllWorktrees,
}: ResumeSessionListProps) {
  const topIndicator = window.showUpIndicator ? `${figures.arrowUp} More` : ' '
  const bottomIndicator = window.showDownIndicator
    ? `${figures.arrowDown} More`
    : ' '
  const visibleListRowCount = Math.max(1, visibleRowsList.length)

  return (
    <Box flexDirection="column" width="100%" minHeight={visibleRows + 2}>
      <Text color={theme.secondaryText} wrap="truncate-end">
        {topIndicator}
      </Text>
      {visibleRowsList.length > 0 ? (
        visibleRowsList.map((row, idx) => {
          const absoluteIndex = window.start + idx
          const isSelected = absoluteIndex === clampedSelection

          const session = row.session
          const modifiedAt =
            session.modifiedAt ?? session.createdAt ?? new Date(0)
          const modifiedLabel = formatDate(modifiedAt)

          const tag = session.tag ? `#${session.tag}` : null
          const branch = session.gitBranch ? `@${session.gitBranch}` : null
          const name = getSessionDisplayName(session)
          const namePrefix =
            row.indexInGroup > 0 ? `${figures.lineUpRight} ` : ''
          const isGroupToggle = row.isGroupHeader && row.groupSize > 1
          const groupIndicator = isGroupToggle
            ? expandedGroups.has(row.groupKey)
              ? figures.triangleDownSmall
              : figures.triangleRightSmall
            : ' '
          const groupCountLabel =
            row.isGroupHeader && row.groupSize > 1
              ? `(+${row.groupSize - 1})`
              : null

          const projectLabel =
            (showAllProjects || showAllWorktrees) && session.cwd
              ? basename(session.cwd)
              : null

          return (
            <Box key={session.sessionId} flexDirection="row" gap={1}>
              <Text color={isSelected ? theme.kode : theme.secondaryText}>
                {isSelected ? figures.pointer : ' '}
              </Text>
              <Text color={theme.secondaryText}>{groupIndicator}</Text>
              <Text color={theme.secondaryText} wrap="truncate-end">
                {modifiedLabel}
              </Text>
              {projectLabel ? (
                <Text color={theme.secondaryText} wrap="truncate-end">
                  {projectLabel}
                </Text>
              ) : null}
              {branch ? (
                <Text color={theme.secondaryText} wrap="truncate-end">
                  {branch}
                </Text>
              ) : null}
              {tag ? (
                <Text color={theme.secondaryText} wrap="truncate-end">
                  {tag}
                </Text>
              ) : null}
              <Text
                bold={isSelected}
                color={isSelected ? theme.text : theme.secondaryText}
                wrap="truncate-end"
              >
                {namePrefix}
                {name}
              </Text>
              {groupCountLabel ? (
                <Text color={theme.secondaryText} wrap="truncate-end">
                  {groupCountLabel}
                </Text>
              ) : null}
            </Box>
          )
        })
      ) : (
        <Text color={theme.secondaryText}>(empty)</Text>
      )}
      {visibleListRowCount < visibleRows
        ? Array.from({
            length: Math.max(0, visibleRows - visibleListRowCount),
          }).map((_, idx) => <Text key={`empty-row-${idx}`}> </Text>)
        : null}
      <Text color={theme.secondaryText} wrap="truncate-end">
        {bottomIndicator}
      </Text>
    </Box>
  )
})

type ResumeSearchInputProps = {
  query: string
  cursorOffset: number
  onCursorOffsetChange: (offset: number) => void
  onChange: (value: string) => void
  onSubmit: () => void
  onCancel: () => void
  onExitSearch: () => void
  onClear: () => void
  onExitToList: () => void
  isFocused: boolean
  isTerminalFocused?: boolean
  theme: Theme
  width: number
}

const ResumeSearchInput = React.memo(function ResumeSearchInput({
  query,
  cursorOffset,
  onCursorOffsetChange,
  onChange,
  onSubmit,
  onCancel,
  onExitSearch,
  onClear,
  onExitToList,
  isFocused,
  isTerminalFocused = true,
  theme,
  width,
}: ResumeSearchInputProps) {
  const prefix = '⌕'
  const columns = Math.max(10, width - 6)
  return (
    <Box
      flexShrink={0}
      borderStyle="round"
      borderColor={isFocused ? theme.suggestion : theme.secondaryBorder}
      paddingX={1}
      width="100%"
    >
      <Box flexDirection="row" gap={1}>
        <Text color={isFocused ? theme.suggestion : theme.secondaryText}>
          {prefix}
        </Text>
        <TextInput
          value={query}
          placeholder="Search…"
          onChange={onChange}
          onSubmit={onSubmit}
          onExit={onCancel}
          columns={columns}
          maxHeight={1}
          cursorOffset={cursorOffset}
          onChangeCursorOffset={onCursorOffsetChange}
          showCursor={isFocused && isTerminalFocused}
          focus={isFocused}
          onSpecialKey={(_inputChar, key) => {
            if (key.ctrl && key.name === 'c') {
              onCancel()
              return true
            }
            if (key.ctrl && key.name === 'n') {
              onExitToList()
              return true
            }
            if ((key.backspace || key.delete) && query.length === 0) {
              onExitSearch()
              return true
            }
            if (key.escape) {
              if (query.trim()) {
                onClear()
              } else {
                onExitSearch()
              }
              return true
            }
            if (key.downArrow) {
              onExitToList()
              return true
            }
            return false
          }}
        />
      </Box>
    </Box>
  )
})

type AgenticSearchState =
  | { status: 'idle' }
  | { status: 'searching'; query: string }
  | { status: 'results'; query: string; results: KodeAgentSessionListItem[] }
  | { status: 'error'; query: string; message: string }

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase()
}

const sessionSearchCache = new WeakMap<KodeAgentSessionListItem, string>()

function getSessionSearchText(session: KodeAgentSessionListItem): string {
  const cached = sessionSearchCache.get(session)
  if (cached) return cached

  const fields = [
    session.sessionId,
    session.customTitle,
    session.slug,
    session.tag,
    session.summary,
    session.firstPrompt,
    session.messageExcerpt,
    session.gitBranch,
    session.cwd,
  ]
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
    .toLowerCase()

  sessionSearchCache.set(session, fields)
  return fields
}

function getGitWorktreeRootsBestEffort(cwd: string): string[] {
  try {
    const stdout = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    })

    const roots: string[] = []
    for (const line of stdout.toString('utf8').split('\n')) {
      if (!line.startsWith('worktree ')) continue
      const path = line.slice('worktree '.length).trim()
      if (path) roots.push(path)
    }

    return Array.from(new Set(roots.map(p => resolvePath(p))))
  } catch {
    return []
  }
}

function isPathWithinRoot(path: string, root: string): boolean {
  const resolvedPath = resolvePath(path)
  const resolvedRoot = resolvePath(root)
  return (
    resolvedPath === resolvedRoot || resolvedPath.startsWith(resolvedRoot + sep)
  )
}

function matchesSessionQuery(
  session: KodeAgentSessionListItem,
  normalizedQuery: string,
) {
  if (!normalizedQuery) return true
  return getSessionSearchText(session).includes(normalizedQuery)
}

const RESUME_AGENTIC_SEARCH_SYSTEM_PROMPT =
  `Your goal is to find relevant sessions based on a user's search query.

You will be given a list of sessions with their metadata and a search query. Identify which sessions are most relevant to the query.

Each session may include:
- Title (display name or custom title)
- Tag (user-assigned category, shown as [tag: name] - users tag sessions with /tag command to categorize them)
- Branch (git branch name, shown as [branch: name])
- Summary (AI-generated summary)
- First message (beginning of the conversation)
- Transcript (excerpt of conversation content)

IMPORTANT: Tags are user-assigned labels that indicate the session's topic or category. If the query matches a tag exactly or partially, those sessions should be highly prioritized.

For each session, consider (in order of priority):
1. Exact tag matches (highest priority - user explicitly categorized this session)
2. Partial tag matches or tag-related terms
3. Title matches (custom titles or first message content)
4. Branch name matches
5. Summary and transcript content matches
6. Semantic similarity and related concepts

CRITICAL: Be VERY inclusive in your matching. Include sessions that:
- Contain the query term anywhere in any field
- Are semantically related to the query (e.g., "testing" matches sessions about "tests", "unit tests", "QA", etc.)
- Discuss topics that could be related to the query
- Have transcripts that mention the concept even in passing

When in doubt, INCLUDE the session. It's better to return too many results than too few. The user can easily scan through results, but missing relevant sessions is frustrating.

Return sessions ordered by relevance (most relevant first). If truly no sessions have ANY connection to the query, return an empty array - but this should be rare.

Respond with ONLY the JSON object, no markdown formatting:
{"relevant_indices": [2, 5, 0]}`.trim()

const resumeAgenticSearchResponseSchema = z.object({
  relevant_indices: z.array(z.number().int()).default([]),
})

const AGENTIC_SEARCH_MAX_SESSIONS = 100
const AGENTIC_SEARCH_MAX_FIRST_PROMPT_CHARS = 300

function getSessionStableId(session: KodeAgentSessionListItem): string {
  return session.slug ?? session.sessionId
}

function buildAgenticSearchPrompt(args: {
  query: string
  sessions: KodeAgentSessionListItem[]
}): string {
  const { query, sessions } = args
  const lines = sessions.map((session, index) => {
    const pieces: string[] = [`${index}:`, getSessionStableId(session)]

    if (
      session.customTitle &&
      session.customTitle !== getSessionStableId(session)
    )
      pieces.push(`[custom title: ${session.customTitle}]`)
    if (session.tag) pieces.push(`[tag: ${session.tag}]`)
    if (session.gitBranch) pieces.push(`[branch: ${session.gitBranch}]`)

    if (session.summary) pieces.push(`- Summary: ${session.summary}`)
    if (session.firstPrompt)
      pieces.push(
        `- First message: ${session.firstPrompt.slice(0, AGENTIC_SEARCH_MAX_FIRST_PROMPT_CHARS)}`,
      )
    if (session.messageExcerpt)
      pieces.push(`- Transcript: ${session.messageExcerpt}`)

    return pieces.join(' ')
  })

  return [
    'Sessions:',
    ...lines,
    '',
    `Search query: "${query}"`,
    '',
    'Find the sessions that are most relevant to this query.',
  ].join('\n')
}

async function agenticSearchSessions(args: {
  query: string
  sessions: KodeAgentSessionListItem[]
  signal: AbortSignal
}): Promise<KodeAgentSessionListItem[]> {
  const { query, sessions, signal } = args
  const trimmedQuery = query.trim()
  const normalizedQuery = normalizeQuery(query)
  if (!normalizedQuery || sessions.length === 0) return []

  const matching = sessions.filter(session =>
    matchesSessionQuery(session, normalizedQuery),
  )
  const nonMatching = sessions.filter(
    session => !matchesSessionQuery(session, normalizedQuery),
  )
  const candidates =
    matching.length >= AGENTIC_SEARCH_MAX_SESSIONS
      ? matching.slice(0, AGENTIC_SEARCH_MAX_SESSIONS)
      : [
          ...matching,
          ...nonMatching.slice(
            0,
            AGENTIC_SEARCH_MAX_SESSIONS - matching.length,
          ),
        ]

  const prompt = buildAgenticSearchPrompt({
    query: trimmedQuery,
    sessions: candidates,
  })

  const assistant = await queryLLM(
    [createUserMessage(prompt)],
    [RESUME_AGENTIC_SEARCH_SYSTEM_PROMPT],
    0,
    [],
    signal,
    {
      safeMode: true,
      model: 'main',
      prependCLISysprompt: true,
      temperature: 0,
    },
  )

  const text =
    assistant.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n') ?? ''

  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonMatch[0])
  } catch {
    return []
  }

  const validated = resumeAgenticSearchResponseSchema.safeParse(parsed)
  if (!validated.success) return []

  const indices = validated.data.relevant_indices
    .filter(idx => Number.isInteger(idx))
    .filter(idx => idx >= 0 && idx < candidates.length)

  const seen = new Set<number>()
  const selected: KodeAgentSessionListItem[] = []
  for (const idx of indices) {
    if (seen.has(idx)) continue
    seen.add(idx)
    const session = candidates[idx]
    if (session) selected.push(session)
  }

  return selected
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function getSessionDisplayName(session: KodeAgentSessionListItem): string {
  const customTitle = session.customTitle?.trim()
  if (customTitle) return customTitle

  const summary = session.summary?.trim()
  if (summary) return summary.split('\n')[0] ?? summary

  const firstPrompt = session.firstPrompt?.trim()
  if (firstPrompt) {
    if (firstPrompt.startsWith('<tick>')) return 'Autonomous session'
    return firstPrompt
  }

  const slug = session.slug?.trim()
  if (slug) return slug

  return session.sessionId
}

function getSessionGroupKey(session: KodeAgentSessionListItem): string {
  return session.forkRootSessionId ?? session.sessionId
}

export function ResumeSessionSelector(props: {
  cwd: string
  sessions: KodeAgentSessionListItem[]
  initialQuery?: string
  onCancel: () => void
  onSelect: (session: KodeAgentSessionListItem) => void | Promise<void>
}): React.ReactNode {
  const { cwd, sessions, onCancel, onSelect } = props
  const theme = getTheme()
  const layout = useScreenLayout()
  const requestExit = useCliExit()
  const exitState = useExitOnCtrlCD(() => requestExit(0))
  const compactVertical = layout.rows <= 26
  const frameGap = compactVertical ? 0 : layout.gap
  const framePaddingY = compactVertical ? 0 : layout.paddingY
  const inputColumns = computeAvailableColumns({
    columns: layout.columns,
    reservedColumns: layout.paddingX * 2 + 4,
  })
  const contentColumns = computeAvailableColumns({
    columns: layout.columns,
    reservedColumns: layout.paddingX * 2,
  })
  const [sessionList, setSessionList] = useState(() => sessions)

  useEffect(() => {
    setSessionList(sessions)
  }, [sessions])

  const [view, setView] = useState<ViewMode>(() =>
    (props.initialQuery ?? '').trim() ? 'search' : 'list',
  )
  const [query, setQuery] = useState(props.initialQuery ?? '')
  const [searchCursorOffset, setSearchCursorOffset] = useState(
    (props.initialQuery ?? '').length,
  )
  const [agenticSearch, setAgenticSearch] = useState<AgenticSearchState>({
    status: 'idle',
  })
  const agenticAbortControllerRef = useRef<AbortController | null>(null)
  const [showAgenticSearchPrompt, setShowAgenticSearchPrompt] = useState(false)
  const [worktreeRoots, setWorktreeRoots] = useState<string[]>([])
  const canFilterWorktrees = worktreeRoots.length > 1
  const [showAllWorktrees, setShowAllWorktrees] = useState(false)
  const [allWorktreeSessions, setAllWorktreeSessions] = useState<
    KodeAgentSessionListItem[] | null
  >(null)
  const [showAllProjects, setShowAllProjects] = useState(false)
  const [allProjectsSessions, setAllProjectsSessions] = useState<
    KodeAgentSessionListItem[] | null
  >(null)
  const [branchFilterEnabled, setBranchFilterEnabled] = useState(false)
  const [currentBranch, setCurrentBranch] = useState<string | null>(null)
  const [selectedIndex, setSelectedIndex] = useScopedIndexState({
    scope: 'resume-session-selector',
    itemCount: sessionList.length,
  })
  const resetSelection = useCallback(() => {
    setSelectedIndex(prev => (prev === 0 ? prev : 0))
  }, [setSelectedIndex])
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => new Set(),
  )

  const [renameValue, setRenameValue] = useState('')
  const [renameCursorOffset, setRenameCursorOffset] = useState(0)

  const [crossProjectCommand, setCrossProjectCommand] = useState<string | null>(
    null,
  )
  const [crossProjectCwd, setCrossProjectCwd] = useState<string | null>(null)
  const [crossProjectTitle, setCrossProjectTitle] = useState<string | null>(
    null,
  )

  const didSubmitRef = useRef(false)
  const mountedRef = useRef(true)
  const crossProjectCopyIdRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      crossProjectCopyIdRef.current += 1
    }
  }, [])

  useEffect(() => {
    return () => {
      agenticAbortControllerRef.current?.abort()
      agenticAbortControllerRef.current = null
    }
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const branch = await getBranch()
        setCurrentBranch(branch || null)
      } catch {
        setCurrentBranch(null)
      }
    })()
  }, [])

  useEffect(() => {
    setWorktreeRoots(getGitWorktreeRootsBestEffort(cwd))
  }, [cwd])

  useEffect(() => {
    if (!showAllProjects) return
    try {
      setAllProjectsSessions(listAllKodeAgentSessions())
    } catch (error) {
      logError(error)
      setAllProjectsSessions([])
    }
  }, [showAllProjects])

  const listWorktreeSessions = useCallback((): KodeAgentSessionListItem[] => {
    if (!canFilterWorktrees) return []

    const seen = new Set<string>()
    const items: KodeAgentSessionListItem[] = []

    for (const root of worktreeRoots) {
      const sessionsForWorktree = listKodeAgentSessions({ cwd: root }).filter(
        session => (session.cwd ? isPathWithinRoot(session.cwd, root) : false),
      )
      for (const s of sessionsForWorktree) {
        if (seen.has(s.sessionId)) continue
        seen.add(s.sessionId)
        items.push(s)
      }
    }

    items.sort((a, b) => {
      const am = a.modifiedAt?.getTime() ?? 0
      const bm = b.modifiedAt?.getTime() ?? 0
      return bm - am
    })

    return items
  }, [canFilterWorktrees, worktreeRoots])

  useEffect(() => {
    if (!showAllWorktrees) return
    try {
      setAllWorktreeSessions(listWorktreeSessions())
    } catch (error) {
      logError(error)
      setAllWorktreeSessions([])
    }
  }, [listWorktreeSessions, showAllWorktrees])

  useEffect(() => {
    if (canFilterWorktrees) return
    if (!showAllWorktrees) return
    setShowAllWorktrees(false)
    setAllWorktreeSessions(null)
  }, [canFilterWorktrees, showAllWorktrees])

  const localSessions = useMemo(() => {
    return sessionList.filter(session => {
      if (!session.cwd) return false
      if (worktreeRoots.length > 0) {
        return worktreeRoots.some(root => isPathWithinRoot(session.cwd!, root))
      }
      return isPathWithinRoot(session.cwd, cwd)
    })
  }, [cwd, sessionList, worktreeRoots])

  const availableTags = useMemo(() => {
    const source = showAllProjects
      ? (allProjectsSessions ?? [])
      : showAllWorktrees
        ? (allWorktreeSessions ?? [])
        : localSessions
    const tags = new Set<string>()
    for (const s of source) {
      if (s.tag) tags.add(s.tag)
    }
    return ['All', ...Array.from(tags).sort((a, b) => a.localeCompare(b))]
  }, [
    allProjectsSessions,
    allWorktreeSessions,
    localSessions,
    showAllProjects,
    showAllWorktrees,
  ])

  const [tagFilterIndex, setTagFilterIndex] = useState(0)
  const activeTag = availableTags[tagFilterIndex] ?? 'All'

  useEffect(() => {
    setSearchCursorOffset(prev => clamp(prev, 0, query.length))
  }, [query])

  useEffect(() => {
    setTagFilterIndex(prev =>
      clamp(prev, 0, Math.max(0, availableTags.length - 1)),
    )
  }, [availableTags.length])

  const sourceSessions = useMemo(
    () =>
      showAllProjects
        ? (allProjectsSessions ?? [])
        : showAllWorktrees
          ? (allWorktreeSessions ?? [])
          : localSessions,
    [
      allProjectsSessions,
      allWorktreeSessions,
      localSessions,
      showAllProjects,
      showAllWorktrees,
    ],
  )
  const normalizedQuery = useMemo(() => normalizeQuery(query), [query])
  const deferredQuery = useDeferredValue(normalizedQuery)

  const getImmediateMatchCount = useCallback(() => {
    let items = sourceSessions

    if (activeTag !== 'All') {
      items = items.filter(s => s.tag === activeTag)
    }

    if (branchFilterEnabled && currentBranch) {
      items = items.filter(s => s.gitBranch === currentBranch)
    }

    if (normalizedQuery) {
      items = items.filter(s => matchesSessionQuery(s, normalizedQuery))
    }

    return items.length
  }, [
    activeTag,
    branchFilterEnabled,
    currentBranch,
    normalizedQuery,
    sourceSessions,
  ])

  const filteredSessions = useMemo(() => {
    let items = sourceSessions

    if (activeTag !== 'All') {
      items = items.filter(s => s.tag === activeTag)
    }

    if (branchFilterEnabled && currentBranch) {
      items = items.filter(s => s.gitBranch === currentBranch)
    }

    if (deferredQuery) {
      items = items.filter(s => matchesSessionQuery(s, deferredQuery))
    }

    return items
  }, [
    activeTag,
    branchFilterEnabled,
    currentBranch,
    deferredQuery,
    sourceSessions,
  ])

  const effectiveSessions = useMemo(() => {
    const trimmedQuery = query.trim()
    if (!trimmedQuery) return filteredSessions

    if (
      agenticSearch.status === 'results' &&
      agenticSearch.query === trimmedQuery
    )
      return agenticSearch.results

    return filteredSessions
  }, [agenticSearch, filteredSessions, query])

  const agenticQuery =
    agenticSearch.status === 'idle' ? '' : agenticSearch.query

  useEffect(() => {
    setShowAgenticSearchPrompt(false)
  }, [query])

  useEffect(() => {
    const trimmedQuery = query.trim()

    if (agenticSearch.status === 'searching') {
      if (agenticQuery === trimmedQuery) return

      agenticAbortControllerRef.current?.abort()
      agenticAbortControllerRef.current = null
      setAgenticSearch({ status: 'idle' })
      return
    }

    if (
      (agenticSearch.status === 'results' ||
        agenticSearch.status === 'error') &&
      agenticQuery !== trimmedQuery
    ) {
      setAgenticSearch({ status: 'idle' })
    }
  }, [agenticQuery, agenticSearch.status, query])

  const agenticResults =
    agenticSearch.status === 'results' ? agenticSearch.results : null

  useEffect(() => {
    if (agenticSearch.status !== 'results') return
    if (!agenticResults || agenticResults.length === 0) return
    resetSelection()
  }, [agenticResults, agenticSearch.status, resetSelection])

  const rows: SessionRow[] = useMemo(() => {
    const groups = new Map<string, KodeAgentSessionListItem[]>()

    for (const session of effectiveSessions) {
      const key = getSessionGroupKey(session)
      const group = groups.get(key)
      if (group) {
        group.push(session)
      } else {
        groups.set(key, [session])
      }
    }

    const result: SessionRow[] = []
    for (const [groupKey, sessionsInGroup] of groups) {
      const groupSize = sessionsInGroup.length
      const isExpanded = expandedGroups.has(groupKey)

      for (
        let indexInGroup = 0;
        indexInGroup < sessionsInGroup.length;
        indexInGroup++
      ) {
        if (indexInGroup > 0 && !isExpanded) continue
        const session = sessionsInGroup[indexInGroup]!
        result.push({
          session,
          groupKey,
          groupSize,
          indexInGroup,
          isGroupHeader: indexInGroup === 0,
        })
      }
    }

    return result
  }, [effectiveSessions, expandedGroups])

  const clampedSelection = rows.length
    ? clamp(selectedIndex, 0, rows.length - 1)
    : 0

  useEffect(() => {
    setSelectedIndex(prev => clamp(prev, 0, Math.max(0, rows.length - 1)))
  }, [rows.length, setSelectedIndex])

  const selectedRow = rows[clampedSelection] ?? null
  const selectedSession = selectedRow?.session ?? null

  const titleRows = exitState.pending ? 2 : 1
  const frameRows =
    titleRows +
    1 + // divider
    frameGap * 2 +
    framePaddingY * 2
  const childCount = 8
  const childGapRows = frameGap * (childCount - 1)
  const reservedRows =
    frameRows +
    childGapRows +
    1 + // tag tabs
    1 + // shortcut line
    3 + // search box (border + content)
    1 + // filters/info line
    1 + // status line
    2 + // list indicators
    1 + // summary line
    1 // error line
  const visibleRows = Math.max(1, layout.rows - reservedRows)

  const window = useMemo(
    () =>
      getWindowedList({
        itemCount: rows.length,
        focusIndex: clampedSelection,
        maxVisible: visibleRows,
        indicatorRows: 2,
      }),
    [clampedSelection, rows.length, visibleRows],
  )

  const visibleRowsList = useMemo(
    () => rows.slice(window.start, window.end),
    [rows, window.end, window.start],
  )

  const close = useCallback(() => {
    didSubmitRef.current = true
    crossProjectCopyIdRef.current += 1
    onCancel()
  }, [onCancel])

  const handleSearchChange = useCallback(
    (value: string) => {
      setQuery(value)
      resetSelection()
      setShowAgenticSearchPrompt(false)
      setSubmitError(null)
    },
    [resetSelection],
  )

  const handleSearchSubmit = useCallback(() => {
    setView('list')
    setSubmitError(null)
    if (query.trim() && getImmediateMatchCount() === 0) {
      setShowAgenticSearchPrompt(true)
    }
  }, [getImmediateMatchCount, query])

  const handleSearchExit = useCallback(() => {
    setView('list')
    setSubmitError(null)
  }, [])

  const handleSearchClear = useCallback(() => {
    setQuery('')
    setSearchCursorOffset(0)
    resetSelection()
    setShowAgenticSearchPrompt(false)
    setSubmitError(null)
  }, [resetSelection])

  const handleSearchExitToList = useCallback(() => {
    setView('list')
    setSubmitError(null)
    if (query.trim() && getImmediateMatchCount() === 0) {
      setShowAgenticSearchPrompt(true)
    }
  }, [getImmediateMatchCount, query])

  const canResumeSessionInCurrentRepo = useCallback(
    (session: KodeAgentSessionListItem): boolean => {
      if (!session.cwd) return false
      if (worktreeRoots.length > 0) {
        return worktreeRoots.some(root => isPathWithinRoot(session.cwd!, root))
      }
      return isPathWithinRoot(session.cwd, cwd)
    },
    [cwd, worktreeRoots],
  )

  const [crossProjectCopyStatus, setCrossProjectCopyStatus] = useState<
    string | null
  >(null)

  const openCrossProject = useCallback(
    async (session: KodeAgentSessionListItem) => {
      if (!session.cwd) {
        setSubmitError('That session is missing its directory metadata')
        return
      }

      const command = `cd ${quote([session.cwd])} && ${PRODUCT_COMMAND} --resume ${session.sessionId}`

      setCrossProjectTitle(getSessionDisplayName(session))
      setCrossProjectCwd(session.cwd)
      setCrossProjectCommand(command)
      setCrossProjectCopyStatus(null)
      setView('crossProject')
      setSubmitError(null)

      const copyId = crossProjectCopyIdRef.current + 1
      crossProjectCopyIdRef.current = copyId
      const isCurrentCopy = () =>
        mountedRef.current && crossProjectCopyIdRef.current === copyId

      try {
        const result = await copyTextToClipboard(command)
        if (!isCurrentCopy()) return
        const suffix =
          result.method === 'osc52' && result.truncated ? ' (truncated)' : ''
        setCrossProjectCopyStatus(`Copied to clipboard${suffix}.`)
      } catch (error) {
        if (!isCurrentCopy()) return
        setCrossProjectCopyStatus(
          `Failed to copy to clipboard: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    },
    [],
  )

  const submitSelection = useCallback(async () => {
    if (didSubmitRef.current) return
    const session = selectedSession
    if (!session) {
      setSubmitError(rows.length === 0 ? 'No matches' : 'Nothing selected')
      return
    }

    if (!canResumeSessionInCurrentRepo(session)) {
      await openCrossProject(session)
      return
    }

    didSubmitRef.current = true
    setSubmitError(null)
    setIsSubmitting(true)
    try {
      await onSelect(session)
    } catch (error) {
      logError(error)
      if (!mountedRef.current) return
      didSubmitRef.current = false
      setIsSubmitting(false)
      setSubmitError(error instanceof Error ? error.message : String(error))
    }
  }, [
    canResumeSessionInCurrentRepo,
    rows.length,
    onSelect,
    openCrossProject,
    selectedSession,
  ])

  const cancelAgenticSearch = useCallback(() => {
    agenticAbortControllerRef.current?.abort()
    agenticAbortControllerRef.current = null
    setAgenticSearch({ status: 'idle' })
    setShowAgenticSearchPrompt(false)
  }, [])

  const startAgenticSearch = useCallback(async () => {
    const trimmedQuery = query.trim()
    if (!trimmedQuery) return

    const baseSessions = sourceSessions
      .filter(s => (activeTag === 'All' ? true : s.tag === activeTag))
      .filter(s =>
        branchFilterEnabled && currentBranch
          ? s.gitBranch === currentBranch
          : true,
      )

    agenticAbortControllerRef.current?.abort()
    const controller = new AbortController()
    agenticAbortControllerRef.current = controller
    setAgenticSearch({ status: 'searching', query: trimmedQuery })
    setSubmitError(null)

    try {
      const results = await agenticSearchSessions({
        query: trimmedQuery,
        sessions: baseSessions,
        signal: controller.signal,
      })
      if (!mountedRef.current) return
      if (controller.signal.aborted) {
        setAgenticSearch({ status: 'idle' })
        return
      }
      setAgenticSearch({ status: 'results', query: trimmedQuery, results })
    } catch (error) {
      if (!mountedRef.current) return
      if (controller.signal.aborted) {
        setAgenticSearch({ status: 'idle' })
        return
      }
      logError(error)
      setAgenticSearch({
        status: 'error',
        query: trimmedQuery,
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      if (agenticAbortControllerRef.current === controller) {
        agenticAbortControllerRef.current = null
      }
    }
  }, [activeTag, branchFilterEnabled, currentBranch, query, sourceSessions])

  const startRename = useCallback(() => {
    if (!selectedSession) return
    setRenameValue(getSessionDisplayName(selectedSession))
    setRenameCursorOffset(getSessionDisplayName(selectedSession).length)
    setView('rename')
    setSubmitError(null)
  }, [selectedSession])

  const commitRename = useCallback(() => {
    const session = selectedSession
    const nextTitle = renameValue.trim()
    if (!session) return
    if (!nextTitle) {
      setSubmitError('Session name cannot be empty')
      return
    }

    const effectiveCwd = session.cwd ?? cwd
    appendSessionCustomTitleRecord({
      cwd: effectiveCwd,
      sessionId: session.sessionId,
      customTitle: nextTitle,
    })

    if (showAllProjects) {
      setAllProjectsSessions(listAllKodeAgentSessions())
    }
    if (showAllWorktrees) {
      setAllWorktreeSessions(listWorktreeSessions())
    }
    if (!showAllProjects && !showAllWorktrees) {
      setSessionList(listKodeAgentSessions({ cwd }))
    }

    setView('list')
    setSubmitError(null)
  }, [
    cwd,
    listWorktreeSessions,
    renameValue,
    selectedSession,
    showAllProjects,
    showAllWorktrees,
  ])

  const [previewLines, setPreviewLines] = useState<string[] | null>(null)
  const [previewScrollTop, setPreviewScrollTop] = useState(0)

  const previewWidth = Math.max(1, layout.columns - layout.paddingX * 2 - 2)
  const previewContentRows = Math.max(1, layout.rows - (framePaddingY * 2 + 6))
  const previewWrapped = useMemo(
    () => (previewLines ? wrapLines(previewLines, previewWidth) : null),
    [previewLines, previewWidth],
  )
  const previewMaxScrollTop = previewWrapped
    ? Math.max(0, previewWrapped.length - previewContentRows)
    : 0

  useEffect(() => {
    if (view !== 'search') return
    setSearchCursorOffset(query.length)
  }, [query.length, view])

  const openPreview = useCallback(() => {
    const session = selectedSession
    if (!session) return

    try {
      const effectiveCwd = session.cwd ?? cwd
      const messages = loadKodeAgentSessionMessages({
        cwd: effectiveCwd,
        sessionId: session.sessionId,
      })
      const rawLines = buildTranscriptLines(messages, {
        includeTools: true,
        collapseToolBlocks: true,
        maxCollapsedChars: 4000,
      })

      setPreviewLines(rawLines)
      setPreviewScrollTop(Math.max(0, rawLines.length - 1))
      setView('preview')
      setSubmitError(null)
    } catch (error) {
      logError(error)
      setSubmitError(error instanceof Error ? error.message : String(error))
    }
  }, [cwd, selectedSession])

  const closePreview = useCallback(() => {
    setView('list')
    setPreviewLines(null)
    setPreviewScrollTop(0)
  }, [])

  const cycleTag = useCallback(
    (direction: 1 | -1) => {
      setTagFilterIndex(prev => {
        if (availableTags.length === 0) return 0
        const next =
          (prev + availableTags.length + direction) % availableTags.length
        return next
      })
    },
    [availableTags.length],
  )

  useKeypress(
    (inputChar, key) => {
      if (didSubmitRef.current) return true

      if (agenticSearch.status === 'searching') {
        if (key.escape || (key.ctrl && inputChar.toLowerCase() === 'c')) {
          cancelAgenticSearch()
          return true
        }
        return true
      }

      const input = inputChar.length === 1 ? inputChar : ''
      const lower = input.toLowerCase()
      const inputText =
        !key.ctrl && !key.meta && key.insertable ? inputChar : ''
      const sanitizedInput = inputText.replace(/[\r\n]+/g, ' ')

      if (view === 'rename') {
        if (key.escape || (key.ctrl && lower === 'c')) {
          setView('list')
          setSubmitError(null)
          return true
        }
        return undefined
      }

      if (view === 'crossProject') {
        if (key.escape || (key.ctrl && lower === 'c')) {
          crossProjectCopyIdRef.current += 1
          setView('list')
          setCrossProjectCommand(null)
          setCrossProjectCwd(null)
          setCrossProjectTitle(null)
          setCrossProjectCopyStatus(null)
          setSubmitError(null)
          return true
        }
        return undefined
      }

      if (view === 'preview') {
        if (key.escape || (key.ctrl && lower === 'c')) {
          closePreview()
          return true
        }

        if (!previewWrapped) return true

        if (key.upArrow) {
          setPreviewScrollTop(prev => clamp(prev - 1, 0, previewMaxScrollTop))
          return true
        }
        if (key.downArrow) {
          setPreviewScrollTop(prev => clamp(prev + 1, 0, previewMaxScrollTop))
          return true
        }
        if (key.pageUp) {
          setPreviewScrollTop(prev =>
            clamp(prev - previewContentRows, 0, previewMaxScrollTop),
          )
          return true
        }
        if (key.pageDown) {
          setPreviewScrollTop(prev =>
            clamp(prev + previewContentRows, 0, previewMaxScrollTop),
          )
          return true
        }
        if (key.home || inputChar === 'g') {
          setPreviewScrollTop(0)
          return true
        }
        if (key.end || inputChar === 'G') {
          setPreviewScrollTop(previewMaxScrollTop)
          return true
        }

        return true
      }

      if (view === 'search') return false

      if (view !== 'list') return undefined

      if (key.ctrl && lower === 'c') {
        close()
        return true
      }

      if (showAgenticSearchPrompt) {
        if (key.return) {
          setShowAgenticSearchPrompt(false)
          void startAgenticSearch()
          return true
        }
        if (key.downArrow) {
          setShowAgenticSearchPrompt(false)
          return true
        }
        if (key.upArrow) {
          setShowAgenticSearchPrompt(false)
          setView('search')
          setSearchCursorOffset(query.length)
          return true
        }
        if (key.escape) {
          setQuery('')
          setSearchCursorOffset(0)
          resetSelection()
          setShowAgenticSearchPrompt(false)
          setSubmitError(null)
          close()
          return true
        }
      }

      if (key.escape) {
        if (query.trim()) {
          setQuery('')
          setSearchCursorOffset(0)
          resetSelection()
          setSubmitError(null)
          return true
        }
        close()
        return true
      }

      if (!key.ctrl && !key.meta && input === '/') {
        setView('search')
        setSearchCursorOffset(query.length)
        setSubmitError(null)
        return true
      }

      if (key.ctrl && lower === 'a') {
        setShowAllProjects(prev => !prev)
        setShowAllWorktrees(false)
        resetSelection()
        setSubmitError(null)
        return true
      }

      if (key.ctrl && lower === 'b') {
        setBranchFilterEnabled(prev => !prev)
        resetSelection()
        setSubmitError(null)
        return true
      }

      if (key.ctrl && lower === 'w') {
        if (!canFilterWorktrees) return true
        setShowAllWorktrees(prev => !prev)
        setShowAllProjects(false)
        resetSelection()
        setSubmitError(null)
        return true
      }

      if (key.tab) {
        cycleTag(key.shift ? -1 : 1)
        resetSelection()
        setSubmitError(null)
        return true
      }

      if (key.ctrl && lower === 'v') {
        openPreview()
        return true
      }

      if (key.ctrl && lower === 'r') {
        startRename()
        return true
      }

      if (key.leftArrow && selectedRow && selectedRow.groupSize > 1) {
        const isExpanded = expandedGroups.has(selectedRow.groupKey)
        if (!isExpanded) return true

        setExpandedGroups(prev => {
          const next = new Set(prev)
          next.delete(selectedRow.groupKey)
          return next
        })

        if (selectedRow.indexInGroup > 0) {
          const headerIndex = rows.findIndex(
            row =>
              row.groupKey === selectedRow.groupKey && row.indexInGroup === 0,
          )
          if (headerIndex >= 0) setSelectedIndex(headerIndex)
        }

        return true
      }

      if (
        key.rightArrow &&
        selectedRow &&
        selectedRow.groupSize > 1 &&
        selectedRow.isGroupHeader
      ) {
        const isExpanded = expandedGroups.has(selectedRow.groupKey)
        if (isExpanded) return true

        setExpandedGroups(prev => {
          const next = new Set(prev)
          next.add(selectedRow.groupKey)
          return next
        })
        return true
      }

      if (key.return) {
        void submitSelection()
        return true
      }

      if (rows.length === 0) return undefined

      if (key.upArrow) {
        if (clampedSelection === 0) {
          setView('search')
          setSubmitError(null)
          return true
        }

        setSelectedIndex(prev => clamp(prev - 1, 0, rows.length - 1))
        return true
      }

      if (key.downArrow) {
        setSelectedIndex(prev => clamp(prev + 1, 0, rows.length - 1))
        return true
      }

      if (key.pageUp) {
        setSelectedIndex(prev => clamp(prev - visibleRows, 0, rows.length - 1))
        return true
      }

      if (key.pageDown) {
        setSelectedIndex(prev => clamp(prev + visibleRows, 0, rows.length - 1))
        return true
      }

      if (key.home) {
        resetSelection()
        return true
      }

      if (key.end) {
        setSelectedIndex(Math.max(0, rows.length - 1))
        return true
      }

      if (sanitizedInput.trim()) {
        const nextQuery = sanitizedInput.trim()
        setQuery(nextQuery)
        setSearchCursorOffset(nextQuery.length)
        resetSelection()
        setView('search')
        setSubmitError(null)
        return true
      }
      return undefined
    },
    { priority: KEYPRESS_PRIORITY.FULLSCREEN_OVERLAY },
  )

  if (sessionList.length === 0) {
    return (
      <ScreenFrame
        title="Resume Session"
        exitState={exitState}
        paddingX={layout.paddingX}
        paddingY={framePaddingY}
        gap={frameGap}
      >
        <Box flexDirection="column" gap={frameGap}>
          <Text bold>No sessions found</Text>
          <Text color={theme.secondaryText}>Press Esc to close.</Text>
        </Box>
      </ScreenFrame>
    )
  }

  if (view === 'preview' && previewWrapped && selectedSession) {
    const clampedTop = clamp(previewScrollTop, 0, previewMaxScrollTop)
    const visible = previewWrapped.slice(
      clampedTop,
      clampedTop + previewContentRows,
    )

    return (
      <ScreenFrame
        title="Session Preview"
        exitState={exitState}
        paddingX={layout.paddingX}
        paddingY={framePaddingY}
        gap={frameGap}
      >
        <Box flexDirection="column" gap={frameGap}>
          <Text color={theme.secondaryText} wrap="truncate-end">
            {getSessionDisplayName(selectedSession)}
          </Text>
          <Box flexDirection="column">
            {visible.map((line, idx) => (
              <Text key={`${clampedTop}:${idx}`} wrap="truncate-end">
                {line}
              </Text>
            ))}
          </Box>
          <Text color={theme.secondaryText} wrap="truncate-end">
            ↑/↓ scroll · PgUp/PgDn · Home/End · Esc close
          </Text>
        </Box>
      </ScreenFrame>
    )
  }

  if (view === 'crossProject' && crossProjectCommand && crossProjectCwd) {
    return (
      <ScreenFrame
        title="Resume Session"
        exitState={exitState}
        paddingX={layout.paddingX}
        paddingY={framePaddingY}
        gap={frameGap}
      >
        <Box flexDirection="column" gap={frameGap}>
          <Text bold>This conversation is from a different directory.</Text>
          {crossProjectTitle ? (
            <Text color={theme.secondaryText} wrap="truncate-end">
              {crossProjectTitle}
            </Text>
          ) : null}
          <Text color={theme.secondaryText} wrap="truncate-end">
            {crossProjectCwd}
          </Text>
          <Text color={theme.secondaryText}>To resume, run:</Text>
          <Text wrap="wrap">{crossProjectCommand}</Text>
          {crossProjectCopyStatus ? (
            <Text color={theme.secondaryText} wrap="truncate-end">
              {crossProjectCopyStatus}
            </Text>
          ) : (
            <Text color={theme.secondaryText} wrap="truncate-end">
              (Command copied to clipboard.)
            </Text>
          )}
          <Text color={theme.secondaryText} wrap="truncate-end">
            Esc back
          </Text>
        </Box>
      </ScreenFrame>
    )
  }

  if (view === 'rename' && selectedSession) {
    return (
      <ScreenFrame
        title="Rename Session"
        exitState={exitState}
        paddingX={layout.paddingX}
        paddingY={framePaddingY}
        gap={frameGap}
      >
        <Box flexDirection="column" gap={frameGap}>
          <Text color={theme.secondaryText} wrap="truncate-end">
            {selectedSession.sessionId}
          </Text>
          <TextInput
            placeholder="Enter new session name…"
            value={renameValue}
            onChange={value => {
              setRenameValue(value)
              setRenameCursorOffset(value.length)
            }}
            onSubmit={() => commitRename()}
            onExit={() => {
              setView('list')
              setSubmitError(null)
            }}
            columns={inputColumns}
            cursorOffset={renameCursorOffset}
            onChangeCursorOffset={setRenameCursorOffset}
            showCursor={true}
            focus={true}
          />
          {submitError ? <Text color={theme.error}>{submitError}</Text> : null}
          <Text color={theme.secondaryText} wrap="truncate-end">
            Enter save · Esc cancel
          </Text>
        </Box>
      </ScreenFrame>
    )
  }

  const scopeLabel = showAllProjects
    ? 'all projects'
    : showAllWorktrees
      ? 'all worktrees'
      : canFilterWorktrees
        ? 'current worktree'
        : 'current dir'

  const infoBits = [
    scopeLabel,
    branchFilterEnabled && currentBranch ? `branch:${currentBranch}` : null,
    activeTag !== 'All' ? `tag:${activeTag}` : null,
  ].filter(Boolean)

  const groupHint =
    selectedRow && selectedRow.groupSize > 1
      ? selectedRow.indexInGroup > 0 || expandedGroups.has(selectedRow.groupKey)
        ? `${figures.arrowLeft} to collapse`
        : `${figures.arrowRight} to expand`
      : null

  const showTagTabs = availableTags.length > 1
  const maxTabs = showTagTabs ? Math.min(availableTags.length, 7) : 0
  const tabStart = showTagTabs
    ? Math.min(
        Math.max(0, tagFilterIndex - Math.floor(maxTabs / 2)),
        Math.max(0, availableTags.length - maxTabs),
      )
    : 0
  const tabSlice = showTagTabs
    ? availableTags.slice(tabStart, tabStart + maxTabs)
    : []
  const hasHiddenLeft = showTagTabs && tabStart > 0
  const hasHiddenRight =
    showTagTabs && tabStart + maxTabs < availableTags.length

  const shortcutLine =
    agenticSearch.status === 'searching'
      ? ['Searching…', 'Esc cancel'].join(' · ')
      : showAgenticSearchPrompt
        ? [
            'No matches',
            'Enter semantic search',
            '↓ skip',
            'Esc cancel',
            '↑ edit query',
          ].join(' · ')
        : view === 'search'
          ? [
              'Type to search',
              'Enter done',
              '↓ done',
              'Esc clear/back',
              'Ctrl+C cancel',
            ].join(' · ')
          : [
              'Type to search',
              '/ search',
              '↑/↓ select',
              'Enter resume',
              'Esc cancel',
              'Ctrl+V preview',
              'Ctrl+R rename',
              ...(canFilterWorktrees ? ['Ctrl+W worktree'] : []),
              'Ctrl+B branch',
              'Ctrl+A scope',
              'Tab tag',
              ...(groupHint ? [groupHint] : []),
            ].join(' · ')

  const statusLineNode =
    agenticSearch.status === 'searching' ? (
      <Box flexDirection="row" gap={1} paddingLeft={2}>
        <SimpleSpinner />
        <Text color={theme.secondaryText} wrap="truncate-end">
          Searching…
        </Text>
      </Box>
    ) : agenticSearch.status === 'results' ? (
      agenticSearch.results.length > 0 ? (
        <Text color={theme.secondaryText} italic wrap="truncate-end">
          Model found these results:
        </Text>
      ) : (
        <Text color={theme.secondaryText} italic wrap="truncate-end">
          No matching sessions found.
        </Text>
      )
    ) : agenticSearch.status === 'error' ? (
      <Text color={theme.secondaryText} italic wrap="truncate-end">
        Semantic search failed: {agenticSearch.message}
      </Text>
    ) : query.trim() && filteredSessions.length === 0 ? (
      <Text color={theme.secondaryText} italic wrap="truncate-end">
        No matching sessions found.
      </Text>
    ) : (
      <Text color={theme.secondaryText} wrap="truncate-end">
        &nbsp;
      </Text>
    )

  return (
    <ScreenFrame
      title="Resume Session"
      exitState={exitState}
      paddingX={layout.paddingX}
      paddingY={framePaddingY}
      gap={frameGap}
    >
      <Box flexDirection="column" gap={frameGap}>
        {showTagTabs ? (
          <Box flexDirection="row" gap={1}>
            {hasHiddenLeft ? (
              <Text color={theme.secondaryText}>{figures.ellipsis}</Text>
            ) : null}
            {tabSlice.map((tag, idx) => {
              const absoluteIndex = tabStart + idx
              const isSelected = absoluteIndex === tagFilterIndex
              const label = tag === 'All' ? 'All' : `#${tag}`
              return (
                <Text
                  key={`${absoluteIndex}:${tag}`}
                  bold={isSelected}
                  color={isSelected ? theme.text : theme.secondaryText}
                  wrap="truncate-end"
                >
                  {label}
                </Text>
              )
            })}
            {hasHiddenRight ? (
              <Text color={theme.secondaryText}>{figures.ellipsis}</Text>
            ) : null}
          </Box>
        ) : (
          <Text color={theme.secondaryText} wrap="truncate-end">
            &nbsp;
          </Text>
        )}

        <Text color={theme.secondaryText} wrap="truncate-end">
          {shortcutLine}
        </Text>

        {view === 'search' ? (
          <ResumeSearchInput
            query={query}
            cursorOffset={searchCursorOffset}
            onCursorOffsetChange={setSearchCursorOffset}
            onChange={handleSearchChange}
            onSubmit={handleSearchSubmit}
            onCancel={close}
            onExitSearch={handleSearchExit}
            onClear={handleSearchClear}
            onExitToList={handleSearchExitToList}
            isFocused={true}
            isTerminalFocused={true}
            theme={theme}
            width={contentColumns}
          />
        ) : (
          <SearchBox query={query} isFocused={false} isTerminalFocused={true} />
        )}

        {infoBits.length > 0 ? (
          <Text color={theme.secondaryText} wrap="truncate-end">
            {infoBits.join(' · ')}
          </Text>
        ) : (
          <Text color={theme.secondaryText} wrap="truncate-end">
            &nbsp;
          </Text>
        )}

        {statusLineNode}

        <ResumeSessionList
          visibleRowsList={visibleRowsList}
          window={window}
          clampedSelection={clampedSelection}
          visibleRows={visibleRows}
          theme={theme}
          expandedGroups={expandedGroups}
          showAllProjects={showAllProjects}
          showAllWorktrees={showAllWorktrees}
        />

        <Box paddingLeft={2} flexDirection="column">
          <Text color={theme.secondaryText} wrap="truncate-end">
            {selectedSession
              ? ((selectedSession.summary ?? '').split('\n')[0] ?? '')
              : ' '}
          </Text>
        </Box>

        <Text
          color={
            submitError
              ? theme.error
              : isSubmitting
                ? theme.success
                : theme.secondaryText
          }
          wrap="truncate-end"
        >
          {submitError ?? (isSubmitting ? 'Resuming conversation…' : ' ')}
        </Text>
      </Box>
    </ScreenFrame>
  )
}
