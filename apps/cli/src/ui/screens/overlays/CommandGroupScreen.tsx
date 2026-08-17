import figures from 'figures'
import React, { useCallback, useMemo, useRef, useState } from 'react'
import { Box, Text } from 'ink'

import type { LocalJSXDoneCallback } from '#cli-commands/types'
import TextInput from '#ui-ink/components/TextInput'
import { KEYPRESS_PRIORITY } from '#ui-ink/constants/keypressPriority'
import { useKeypress } from '#ui-ink/hooks/useKeypress'
import { useScopedIndexState } from '#ui-ink/hooks/useScopedIndexState'
import { PressableRow } from '#ui-ink/primitives/list/PressableRow'
import { getWindowedList } from '#ui-ink/primitives/list/windowedList'
import { ScreenFrame } from '#ui-ink/primitives/layout/ScreenFrame'
import { useScreenLayout } from '#ui-ink/primitives/layout/useScreenLayout'
import { getTheme } from '#core/utils/theme'

export type CommandGroupItem = {
  id: string
  commandName: string
  label: string
  description: string
  aliases?: readonly string[]
  argumentHint?: string
}

export function filterCommandGroupItems(
  items: readonly CommandGroupItem[],
  query: string,
): readonly CommandGroupItem[] {
  const terms = query.trim().toLowerCase().split(/\s+/u).filter(Boolean)
  if (terms.length === 0) return items

  return items.filter(item => {
    const searchableText = [
      item.id,
      item.label,
      item.description,
      ...(item.aliases ?? []),
    ]
      .join(' ')
      .toLowerCase()
    return terms.every(term => searchableText.includes(term))
  })
}

export function CommandGroupRedirect({
  commandName,
  args,
  onDone,
}: {
  commandName: string
  args: string
  onDone: LocalJSXDoneCallback
}): React.ReactNode {
  const didDelegate = useRef(false)

  React.useEffect(() => {
    if (didDelegate.current) return
    didDelegate.current = true
    onDone({ type: 'delegate-command', commandName, args })
  }, [args, commandName, onDone])

  return null
}

export function CommandGroupScreen({
  title,
  description,
  items,
  initialQuery = '',
  onDone,
}: {
  title: string
  description: string
  items: readonly CommandGroupItem[]
  initialQuery?: string
  onDone: LocalJSXDoneCallback
}): React.ReactNode {
  const theme = getTheme()
  const layout = useScreenLayout()
  const normalizedInitialQuery = initialQuery.trim()
  const [filterQuery, setFilterQuery] = useState(normalizedInitialQuery)
  const [filterCursorOffset, setFilterCursorOffset] = useState(
    normalizedInitialQuery.length,
  )
  const [filterOpen, setFilterOpen] = useState(
    normalizedInitialQuery.length > 0,
  )
  const filteredItems = useMemo(
    () => filterCommandGroupItems(items, filterQuery),
    [filterQuery, items],
  )
  const [selectedIndex, setSelectedIndex] = useScopedIndexState({
    scope: `command-group:${title}`,
    itemCount: filteredItems.length,
  })
  const exitState = { pending: false, keyName: null } as const
  const selectedItem = filteredItems[selectedIndex]
  const reservedRows =
    (layout.tightLayout ? 7 : layout.compactLayout ? 9 : 11) +
    (filterOpen ? 1 : 0) +
    layout.paddingY * 2 +
    layout.gap * 3
  const maxVisible = Math.max(3, layout.rows - reservedRows)
  const window = useMemo(
    () =>
      getWindowedList({
        itemCount: filteredItems.length,
        focusIndex: selectedIndex,
        maxVisible,
        indicatorRows: 2,
      }),
    [filteredItems.length, maxVisible, selectedIndex],
  )
  const visibleItems = filteredItems.slice(window.start, window.end)

  const updateFilter = useCallback(
    (nextValue: string) => {
      setFilterQuery(nextValue)
      setFilterCursorOffset(nextValue.length)
      setSelectedIndex(0)
    },
    [setSelectedIndex],
  )

  const selectItem = useCallback(
    (item: CommandGroupItem | undefined) => {
      if (!item) return
      onDone({
        type: 'delegate-command',
        commandName: item.commandName,
        args: '',
      })
    },
    [onDone],
  )

  useKeypress(
    (input, key) => {
      const inputChar = input.length === 1 ? input : ''
      const lowerInputChar = inputChar.toLowerCase()
      const typedInput =
        key.insertable && !key.ctrl && !key.meta && input.length > 0
          ? input
          : ''

      if (key.ctrl && lowerInputChar === 'c') {
        onDone()
        return true
      }

      if (key.escape) {
        if (filterOpen && filterQuery.length > 0) {
          updateFilter('')
          return true
        }
        if (filterOpen) {
          setFilterOpen(false)
          return true
        }
        onDone()
        return true
      }

      if (
        !filterOpen &&
        (typedInput === '/' || (key.ctrl && lowerInputChar === 'f'))
      ) {
        setFilterOpen(true)
        return true
      }

      if (filterOpen && (key.backspace || key.delete || typedInput)) {
        return false
      }

      if (key.return || (!filterOpen && inputChar === ' ')) {
        selectItem(selectedItem)
        return true
      }

      if (key.upArrow || (!filterOpen && inputChar === 'k')) {
        setSelectedIndex(current => Math.max(0, current - 1))
        return true
      }
      if (key.downArrow || (!filterOpen && inputChar === 'j')) {
        setSelectedIndex(current =>
          Math.min(Math.max(0, filteredItems.length - 1), current + 1),
        )
        return true
      }
      if (key.pageUp) {
        setSelectedIndex(current => Math.max(0, current - window.visibleCount))
        return true
      }
      if (key.pageDown) {
        setSelectedIndex(current =>
          Math.min(
            Math.max(0, filteredItems.length - 1),
            current + window.visibleCount,
          ),
        )
        return true
      }
      if (!filterOpen && /^[1-9]$/u.test(inputChar)) {
        selectItem(filteredItems[Number(inputChar) - 1])
        return true
      }
      if (!filterOpen && typedInput) {
        setFilterOpen(true)
        updateFilter(typedInput)
        return true
      }
      return undefined
    },
    { priority: KEYPRESS_PRIORITY.FULLSCREEN_OVERLAY },
  )

  const shortcutLine = filterOpen
    ? 'Type to filter · ↑/↓ select · Enter open · Esc clear/back'
    : 'Type or / to filter · ↑/↓ or j/k select · Enter open · Esc close'
  const statusText = filterOpen
    ? `${filteredItems.length} match${filteredItems.length === 1 ? '' : 'es'} · Enter opens the highlighted command`
    : `${items.length} commands · Type /${title.slice(1)} <command> to open one directly`
  const selectedPath = selectedItem
    ? `Direct path: ${title} ${selectedItem.id}${selectedItem.argumentHint ? ` ${selectedItem.argumentHint}` : ''}`
    : undefined
  const topIndicator = window.showUpIndicator
    ? `${figures.arrowUp} ${window.start} above`
    : ' '
  const bottomIndicator = window.showDownIndicator
    ? `${figures.arrowDown} ${filteredItems.length - window.end} below`
    : ' '

  return (
    <ScreenFrame
      title={title}
      exitState={exitState}
      paddingX={layout.paddingX}
      paddingY={layout.paddingY}
      gap={layout.gap}
    >
      <Box flexDirection="column" gap={layout.gap}>
        <Text color={theme.secondaryText} wrap="truncate-end">
          {description}
        </Text>
        <Text
          color={
            filteredItems.length === 0 ? theme.warning : theme.secondaryText
          }
          wrap="truncate-end"
        >
          {statusText}
        </Text>

        {filterOpen ? (
          <Box flexDirection="row">
            <Text color={theme.kode}>Filter: </Text>
            <TextInput
              value={filterQuery}
              onChange={updateFilter}
              placeholder="command, alias, or description"
              columns={Math.max(1, layout.columns - layout.paddingX * 2 - 8)}
              cursorOffset={filterCursorOffset}
              onChangeCursorOffset={setFilterCursorOffset}
              showCursor={true}
              focus={true}
              disableCursorMovementForUpDownKeys={true}
            />
          </Box>
        ) : null}

        <Box flexDirection="column" width="100%">
          <Text dimColor wrap="truncate-end">
            {topIndicator}
          </Text>
          {visibleItems.length > 0 ? (
            visibleItems.map((item, index) => {
              const absoluteIndex = window.start + index
              const isSelected = absoluteIndex === selectedIndex
              const argumentHint = item.argumentHint
                ? ` ${item.argumentHint}`
                : ''
              return (
                <PressableRow
                  key={item.id}
                  width="100%"
                  onPress={() => selectItem(item)}
                >
                  <Text color={isSelected ? theme.kode : theme.secondaryText}>
                    {isSelected ? figures.pointer : ' '}
                  </Text>
                  <Box flexGrow={1} overflow="hidden">
                    <Text
                      color={isSelected ? theme.text : theme.secondaryText}
                      bold={isSelected}
                      wrap="truncate-end"
                    >
                      {` ${absoluteIndex + 1}. /${item.id}${argumentHint} — ${item.label}: ${item.description}`}
                    </Text>
                  </Box>
                </PressableRow>
              )
            })
          ) : (
            <Text color={theme.warning} wrap="truncate-end">
              No matching command. Keep typing or press Esc to clear the filter.
            </Text>
          )}
          <Text dimColor wrap="truncate-end">
            {bottomIndicator}
          </Text>
        </Box>

        {selectedPath ? (
          <Text color={theme.secondaryText} wrap="truncate-end">
            {selectedPath}
          </Text>
        ) : null}
        <Text dimColor wrap="truncate-end">
          {shortcutLine}
        </Text>
      </Box>
    </ScreenFrame>
  )
}
