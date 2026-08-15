import React, { useCallback, useMemo, useState } from 'react'
import { Box, Text } from 'ink'
import figures from 'figures'

import { getGlobalHistoryWithPastes } from '#core/history'
import { getTheme } from '#core/utils/theme'
import { matchAdvanced } from '#cli-utils/completion/advancedFuzzyMatcher'
import TextInput from '#ui-ink/components/TextInput'
import type { Key } from '#ui-ink/hooks/useKeypress'
import { useKeypress } from '#ui-ink/hooks/useKeypress'
import { KEYPRESS_PRIORITY } from '#ui-ink/constants/keypressPriority'
import { ScreenFrame } from '#ui-ink/primitives/layout/ScreenFrame'
import { useScreenLayout } from '#ui-ink/primitives/layout/useScreenLayout'
import { computeAvailableColumns } from '#ui-ink/primitives/layout/viewportColumns'
import { useScopedIndexState } from '#ui-ink/hooks/useScopedIndexState'

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase()
}

// Rank history entries so the best match is on top: exact/substring matches
// keep priority, then fuzzy (abbreviation/subsequence) matches fill in.
type HistoryEntry = {
  display: string
  pastedTexts: Array<{ placeholder: string; text: string }>
}

function rankHistoryEntries(
  items: HistoryEntry[],
  query: string,
): HistoryEntry[] {
  if (!query) return items

  const ranked = items
    .map(item => {
      const haystack = item.display.toLowerCase()
      if (haystack.includes(query)) {
        const position = haystack.indexOf(query)
        return { item, score: 10000 - position }
      }
      const result = matchAdvanced(item.display, query)
      return result.matched ? { item, score: Math.max(1, result.score) } : null
    })
    .filter(
      (entry): entry is { item: HistoryEntry; score: number } => entry !== null,
    )
    .sort((a, b) => b.score - a.score)

  return ranked.map(entry => entry.item)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export type HistorySearchDoneResult =
  | {
      action: 'accept'
      value: string
      pastedTexts: Array<{ placeholder: string; text: string }>
    }
  | {
      action: 'execute'
      value: string
      pastedTexts: Array<{ placeholder: string; text: string }>
    }
  | { action: 'cancel' }

export function HistorySearchScreen({
  onDone,
}: {
  onDone: (result: HistorySearchDoneResult) => void
}): React.ReactNode {
  const theme = getTheme()
  const layout = useScreenLayout()
  const exitState = { pending: false, keyName: null as null } as const
  const inputColumns = computeAvailableColumns({
    columns: layout.columns,
    reservedColumns: layout.paddingX * 2 + 4,
  })

  const [query, setQuery] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const [status, setStatus] = useState<string | null>(null)

  const normalizedQuery = useMemo(() => normalizeQuery(query), [query])
  const history = useMemo(() => getGlobalHistoryWithPastes(), [])
  const filtered = useMemo(
    () => rankHistoryEntries(history, normalizedQuery),
    [history, normalizedQuery],
  )
  const [selectedIndex, setSelectedIndex] = useScopedIndexState({
    scope: 'history-search',
    itemCount: filtered.length,
  })

  const clampedSelection = filtered.length
    ? clamp(selectedIndex, 0, filtered.length - 1)
    : 0

  const acceptSelection = useCallback(() => {
    const selected = filtered[clampedSelection]
    if (!selected) {
      setStatus(filtered.length === 0 ? 'No matches' : 'Nothing selected')
      return
    }
    onDone({
      action: 'accept',
      value: selected.display,
      pastedTexts: selected.pastedTexts,
    })
  }, [clampedSelection, filtered, onDone])

  const executeSelection = useCallback(() => {
    const selected = filtered[clampedSelection]
    if (!selected) {
      setStatus(filtered.length === 0 ? 'No matches' : 'Nothing selected')
      return
    }
    onDone({
      action: 'execute',
      value: selected.display,
      pastedTexts: selected.pastedTexts,
    })
  }, [clampedSelection, filtered, onDone])

  const cycleNext = useCallback(() => {
    if (filtered.length === 0) return
    setSelectedIndex(prev => (prev + 1) % filtered.length)
  }, [filtered.length, setSelectedIndex])

  const onSpecialKey = useCallback(
    (input: string, key: Key): boolean => {
      const inputChar = input.length === 1 ? input : ''

      if (key.ctrl && inputChar === 'c') {
        onDone({ action: 'cancel' })
        return true
      }

      if (key.ctrl && key.return) {
        executeSelection()
        return true
      }

      if (key.tab) {
        acceptSelection()
        return true
      }

      if (key.return) {
        acceptSelection()
        return true
      }

      if (key.ctrl && inputChar === 'r') {
        cycleNext()
        return true
      }

      if (key.escape) {
        if (query.trim()) {
          setQuery('')
          setCursorOffset(0)
          setSelectedIndex(0)
          setStatus(null)
          return true
        }
        onDone({ action: 'cancel' })
        return true
      }

      if (key.upArrow) {
        if (filtered.length === 0) return true
        setSelectedIndex(prev => clamp(prev - 1, 0, filtered.length - 1))
        return true
      }
      if (key.downArrow) {
        if (filtered.length === 0) return true
        setSelectedIndex(prev => clamp(prev + 1, 0, filtered.length - 1))
        return true
      }

      return false
    },
    [
      acceptSelection,
      cycleNext,
      executeSelection,
      filtered.length,
      onDone,
      query,
      setSelectedIndex,
    ],
  )

  useKeypress(
    (input, key) => {
      if (key.ctrl && input === 'c') {
        onDone({ action: 'cancel' })
        return true
      }
      return undefined
    },
    { priority: KEYPRESS_PRIORITY.FULLSCREEN_OVERLAY },
  )

  const shortcutLine =
    'Type to filter · ↑/↓ select · Enter accept · Ctrl+Enter execute · Esc clear/back · Ctrl+R next · Ctrl+C cancel'

  return (
    <ScreenFrame
      title="History Search"
      exitState={exitState}
      paddingX={layout.paddingX}
      paddingY={layout.paddingY}
      gap={layout.gap}
    >
      <Box flexDirection="column" gap={layout.gap}>
        <Text color={theme.secondaryText} wrap="truncate-end">
          {shortcutLine}
        </Text>

        <Box flexDirection="row" gap={1}>
          <Text color={theme.secondaryText}>{figures.pointerSmall}</Text>
          <TextInput
            placeholder="Search history…"
            value={query}
            onChange={value => {
              setQuery(value)
              setCursorOffset(value.length)
              setStatus(null)
              setSelectedIndex(0)
            }}
            onSubmit={() => acceptSelection()}
            onExit={() => onDone({ action: 'cancel' })}
            columns={inputColumns}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            showCursor={true}
            focus={true}
            disableCursorMovementForUpDownKeys={true}
            onSpecialKey={onSpecialKey}
          />
        </Box>

        <Box flexDirection="column">
          <Text color={theme.secondaryText} wrap="truncate-end">
            {status ??
              (filtered.length === 0
                ? 'No matches'
                : `Showing ${filtered.length} matches`)}
          </Text>

          {filtered.length > 0 ? (
            filtered.slice(0, 12).map((item, idx) => {
              const isSelected = idx === clampedSelection
              return (
                <Text
                  key={`${idx}:${item.display}`}
                  color={isSelected ? theme.text : theme.secondaryText}
                  wrap="truncate-end"
                  bold={isSelected}
                >
                  {isSelected ? figures.pointer : ' '} {item.display}
                </Text>
              )
            })
          ) : (
            <Text color={theme.secondaryText}>(empty)</Text>
          )}
        </Box>

        <Text color={theme.secondaryText} wrap="truncate-end">
          Tip: history includes /bash commands
        </Text>
      </Box>
    </ScreenFrame>
  )
}
