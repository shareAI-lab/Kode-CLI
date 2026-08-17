import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text } from 'ink'
import figures from 'figures'
import { getTheme } from '#core/utils/theme'
import TextInput from '#ui-ink/components/TextInput'
import type { Key } from '#ui-ink/hooks/useKeypress'
import { ScreenFrame } from '#ui-ink/primitives/layout/ScreenFrame'
import { useScreenLayout } from '#ui-ink/primitives/layout/useScreenLayout'
import { computeAvailableColumns } from '#ui-ink/primitives/layout/viewportColumns'
import type { Command } from '#cli-commands'
import {
  compareCommandsForDiscovery,
  getCommandCategory,
} from '#cli-commands/catalog'

type PaletteAction = {
  kind: 'action'
  id:
    | 'help'
    | 'config'
    | 'open'
    | 'console'
    | 'notifications'
    | 'transcript'
    | 'model'
    | 'doctor'
  label: string
  hint?: string
  shortcut?: string
}

type PaletteCommand = {
  kind: 'command'
  id: string
  name: string
  label: string
  hint: string
  argumentHint?: string
  aliases: string[]
}

type PaletteItem = PaletteAction | PaletteCommand

export type CommandPaletteResult =
  | PaletteAction['id']
  | {
      kind: 'command'
      name: string
      argumentHint?: string
    }

const VIEWPORT_SAFE_MARGIN_ROWS = 1
const COMMANDS_WITH_DEDICATED_ACTIONS = new Set([
  'help',
  'config',
  'open',
  'console',
  'notifications',
  'transcript',
  'model',
  'doctor',
])

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function getDefaultActions(): PaletteAction[] {
  return [
    {
      kind: 'action',
      id: 'help',
      label: 'Help',
      shortcut: 'F1',
      hint: 'Keybindings and commands',
    },
    {
      kind: 'action',
      id: 'config',
      label: 'Config',
      shortcut: 'F2',
      hint: 'Global settings',
    },
    {
      kind: 'action',
      id: 'open',
      label: 'Open File',
      shortcut: 'F3',
      hint: 'Quick open + external editor',
    },
    {
      kind: 'action',
      id: 'console',
      label: 'Console',
      shortcut: 'F4',
      hint: 'Captured stdout/stderr (TUI guard)',
    },
    {
      kind: 'action',
      id: 'notifications',
      label: 'Notifications',
      shortcut: 'F5',
      hint: 'In-app inbox',
    },
    {
      kind: 'action',
      id: 'transcript',
      label: 'Transcript',
      shortcut: 'F6',
      hint: 'Scroll + copy conversation',
    },
    {
      kind: 'action',
      id: 'model',
      label: 'Models',
      hint: 'Provider + model settings',
    },
    {
      kind: 'action',
      id: 'doctor',
      label: 'Doctor',
      hint: 'Terminal capability check',
    },
  ]
}

function normalizeQuery(value: string): string {
  return value.trim().replace(/^\//, '').toLowerCase()
}

function getCommandItems(commands: Command[]): PaletteCommand[] {
  return commands
    .filter(
      command =>
        command.isEnabled &&
        !command.isHidden &&
        !COMMANDS_WITH_DEDICATED_ACTIONS.has(command.userFacingName()),
    )
    .sort(compareCommandsForDiscovery)
    .map(command => {
      const name = command.userFacingName()
      const category = getCommandCategory(command)
      return {
        kind: 'command' as const,
        id: `command:${name}`,
        name,
        label: `/${name}${
          command.argumentHint ? ` ${command.argumentHint}` : ''
        } · ${category.shortLabel}`,
        hint: `${category.label} — ${command.description}`,
        argumentHint: command.argumentHint,
        aliases: command.aliases ?? [],
      }
    })
}

function matchesQuery(item: PaletteItem, query: string): boolean {
  if (!query) return true
  const haystack =
    item.kind === 'action'
      ? `${item.id} ${item.label} ${item.hint ?? ''} ${
          item.shortcut ?? ''
        }`.toLowerCase()
      : `${item.name} ${item.label} ${item.hint} ${item.aliases.join(' ')}`.toLowerCase()
  return haystack.includes(query)
}

function getSelectedHint(item: PaletteItem): string {
  if (item.kind === 'action') return item.hint ?? ''

  const aliasHint = item.aliases.length
    ? `Aliases: ${item.aliases.map(alias => `/${alias}`).join(', ')}`
    : ''
  return [item.hint, aliasHint].filter(Boolean).join(' - ')
}

export function CommandPaletteScreen({
  onDone,
  commands = [],
}: {
  onDone: (result?: CommandPaletteResult) => void
  commands?: Command[]
}): React.ReactNode {
  const theme = getTheme()
  const layout = useScreenLayout()
  const { rows, columns } = layout
  const exitState = { pending: false, keyName: null as null } as const

  const paddingY = layout.paddingY
  const gap = layout.gap
  const paddingX = layout.paddingX
  const inputColumns = computeAvailableColumns({
    columns,
    reservedColumns: paddingX * 2 + 4,
  })

  const [query, setQuery] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const [focusedIndex, setFocusedIndex] = useState(0)
  const [status, setStatus] = useState<string | null>(null)

  const actions = useMemo(() => getDefaultActions(), [])
  const commandItems = useMemo(() => getCommandItems(commands), [commands])
  const items = useMemo(
    () => [...actions, ...commandItems],
    [actions, commandItems],
  )
  const normalizedQuery = useMemo(() => normalizeQuery(query), [query])
  const filtered = useMemo(
    () => items.filter(item => matchesQuery(item, normalizedQuery)),
    [items, normalizedQuery],
  )

  useEffect(() => {
    setFocusedIndex(prev => clamp(prev, 0, Math.max(0, filtered.length - 1)))
  }, [filtered.length])

  const headerRows = 4
  const footerRows = 1
  const reservedLines =
    (layout.tightLayout ? 8 : layout.compactLayout ? 10 : 12) +
    paddingY * 2 +
    gap * 4
  const availableForList = Math.max(
    3,
    rows - reservedLines - headerRows - footerRows - VIEWPORT_SAFE_MARGIN_ROWS,
  )
  const visibleOptionCount = Math.max(
    3,
    Math.min(10, filtered.length || 10, availableForList),
  )

  const clampedFocus =
    filtered.length === 0 ? 0 : clamp(focusedIndex, 0, filtered.length - 1)
  const half = Math.floor(visibleOptionCount / 2)
  const start = Math.max(
    0,
    Math.min(
      clampedFocus - half,
      Math.max(0, filtered.length - visibleOptionCount),
    ),
  )
  const end = Math.min(filtered.length, start + visibleOptionCount)
  const showUp = start > 0
  const showDown = end < filtered.length

  const runSelection = useCallback(() => {
    const action = filtered[clampedFocus]
    if (!action) {
      setStatus(filtered.length === 0 ? 'No matches' : 'Nothing selected')
      return
    }
    onDone(
      action.kind === 'action'
        ? action.id
        : {
            kind: 'command',
            name: action.name,
            argumentHint: action.argumentHint,
          },
    )
  }, [clampedFocus, filtered, onDone])

  const onSpecialKey = useCallback(
    (_input: string, key: Key): boolean => {
      if (key.escape) {
        // First Esc clears the query (like the model/theme/history pickers);
        // only a second Esc closes the palette.
        if (query.length > 0) {
          setQuery('')
          setCursorOffset(0)
          setFocusedIndex(0)
          setStatus(null)
          return true
        }
        onDone()
        return true
      }

      if (key.return) {
        runSelection()
        return true
      }

      const inputChar = _input.length === 1 ? _input : ''
      const isUp =
        key.upArrow || (key.ctrl && (inputChar === 'p' || inputChar === 'k'))
      const isDown =
        key.downArrow || (key.ctrl && (inputChar === 'n' || inputChar === 'j'))

      if (filtered.length === 0) {
        if (
          isUp ||
          isDown ||
          key.pageUp ||
          key.pageDown ||
          key.home ||
          key.end
        ) {
          return true
        }
        return false
      }

      if (isUp) {
        setFocusedIndex(prev => clamp(prev - 1, 0, filtered.length - 1))
        return true
      }
      if (isDown) {
        setFocusedIndex(prev => clamp(prev + 1, 0, filtered.length - 1))
        return true
      }
      if (key.pageUp) {
        setFocusedIndex(prev =>
          clamp(prev - visibleOptionCount, 0, filtered.length - 1),
        )
        return true
      }
      if (key.pageDown) {
        setFocusedIndex(prev =>
          clamp(prev + visibleOptionCount, 0, filtered.length - 1),
        )
        return true
      }
      if (key.home) {
        setFocusedIndex(0)
        return true
      }
      if (key.end) {
        setFocusedIndex(filtered.length - 1)
        return true
      }

      return false
    },
    [filtered.length, onDone, query.length, runSelection, visibleOptionCount],
  )

  const visible = useMemo(
    () => filtered.slice(start, end),
    [end, filtered, start],
  )
  const selected = filtered[clampedFocus]
  const actionCount = filtered.filter(item => item.kind === 'action').length
  const commandCount = filtered.length - actionCount

  return (
    <ScreenFrame
      title="Command Palette"
      exitState={exitState}
      paddingX={paddingX}
      paddingY={paddingY}
      gap={gap}
    >
      <Box flexDirection="column" gap={gap}>
        <Box flexDirection="column">
          <Text color={theme.secondaryText} wrap="truncate-end">
            Search actions or /commands. Enter opens or inserts. Esc clears
            search, again closes.
          </Text>
          <Box flexDirection="row" gap={1}>
            <Text color={theme.secondaryText}>{figures.pointerSmall}</Text>
            <TextInput
              placeholder="Search actions or /commands"
              value={query}
              onChange={value => {
                setQuery(value)
                setCursorOffset(value.length)
                setFocusedIndex(0)
                setStatus(null)
              }}
              onSubmit={() => runSelection()}
              onExit={() => onDone()}
              columns={inputColumns}
              cursorOffset={cursorOffset}
              onChangeCursorOffset={setCursorOffset}
              showCursor={true}
              focus={true}
              disableCursorMovementForUpDownKeys={true}
              onSpecialKey={onSpecialKey}
            />
          </Box>
        </Box>

        <Box flexDirection="column" gap={0}>
          <Text color={theme.secondaryText} wrap="truncate-end">
            {status ??
              (filtered.length === 0
                ? 'No matches'
                : `Showing ${visible.length} of ${filtered.length} (${actionCount} actions, ${commandCount} commands)`)}
          </Text>
          <Box flexDirection="column" width="100%">
            <Text color={theme.secondaryText} wrap="truncate-end">
              {showUp ? `${figures.arrowUp} More` : ' '}
            </Text>
            {visible.map((action, idx) => {
              const absoluteIndex = start + idx
              const isFocused = absoluteIndex === clampedFocus
              const suffix =
                action.kind === 'action' && action.shortcut
                  ? ` - ${action.shortcut}`
                  : ''
              return (
                <Box key={action.id} flexDirection="row" gap={1}>
                  <Text color={isFocused ? theme.kode : theme.secondaryText}>
                    {isFocused ? figures.pointer : ' '}
                  </Text>
                  <Text
                    color={isFocused ? theme.text : theme.secondaryText}
                    bold={isFocused}
                    wrap="truncate-end"
                  >
                    {action.label}
                    {suffix}
                  </Text>
                </Box>
              )
            })}
            <Text color={theme.secondaryText} wrap="truncate-end">
              {showDown ? `${figures.arrowDown} More` : ' '}
            </Text>
          </Box>
        </Box>

        {selected ? (
          <Box flexDirection="column">
            <Text color={theme.secondaryText} wrap="truncate-end">
              {getSelectedHint(selected)}
            </Text>
          </Box>
        ) : null}

        <Box marginTop={layout.tightLayout ? 0 : 1}>
          <Text color={theme.secondaryText} wrap="truncate-end">
            Arrows · PgUp/PgDn · Home/End · Enter select · Esc clear/close
          </Text>
        </Box>
      </Box>
    </ScreenFrame>
  )
}
