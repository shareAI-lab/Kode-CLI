import React, { useCallback, useMemo, useRef } from 'react'
import { Box, Text } from 'ink'
import { useKeypress } from '#ui-ink/hooks/useKeypress'
import { ScreenFrame } from '#ui-ink/primitives/layout/ScreenFrame'
import { useScreenLayout } from '#ui-ink/primitives/layout/useScreenLayout'
import { getTheme, type Theme } from '#core/utils/theme'
import { isExperimentalVoiceEnabled } from '#core/utils/config'
import { getPermissionModeCycleShortcut } from '#ui-ink/utils/permissionModeCycleShortcut'
import {
  getCommandShortcutHints,
  getShortcutModifierLabel,
} from '#ui-ink/utils/commandShortcutHints'

type Props = {
  onDone: () => void
}

type ShortcutRow = {
  label: string
  detail: string
  tone: 'command' | 'shortcut' | 'neutral'
}

function ShortcutHint({
  row,
  theme,
}: {
  row: ShortcutRow
  theme: Theme
}): React.ReactNode {
  const color =
    row.tone === 'command'
      ? theme.primary
      : row.tone === 'shortcut'
        ? theme.warning
        : theme.text

  return (
    <Text wrap="truncate-end">
      <Text color={color} bold>
        {row.label}
      </Text>
      <Text color={theme.text}>{` ${row.detail}`}</Text>
    </Text>
  )
}

function ShortcutColumn({
  rows,
  theme,
  width,
}: {
  rows: readonly ShortcutRow[]
  theme: Theme
  width?: number
}): React.ReactNode {
  return (
    <Box flexDirection="column" width={width}>
      {rows.map(row => (
        <ShortcutHint key={row.label} row={row} theme={theme} />
      ))}
    </Box>
  )
}

export function ShortcutsScreen({ onDone }: Props): React.ReactNode {
  const theme = getTheme()
  const layout = useScreenLayout()
  const exitState = { pending: false, keyName: null as null } as const
  const didDoneRef = useRef(false)

  const safeOnDone = useCallback(() => {
    if (didDoneRef.current) return
    didDoneRef.current = true
    onDone()
  }, [onDone])

  const modeCycleShortcut = useMemo(() => getPermissionModeCycleShortcut(), [])
  const { commands, shortcuts } = useMemo(() => getCommandShortcutHints(), [])
  const shortcutModifier = getShortcutModifierLabel()
  const modelShortcut = shortcuts[0] ?? {
    trigger: 'Alt+M',
    effect: 'switch model',
  }
  const editorShortcut = shortcuts[1] ?? {
    trigger: 'Alt+G',
    effect: 'open external editor',
  }
  const voiceShortcut = isExperimentalVoiceEnabled()
    ? {
        label: 'F10',
        detail: 'voice conversation; tap to start/stop recording',
        tone: 'shortcut' as const,
      }
    : null

  useKeypress((input, key) => {
    const inputChar = input.length === 1 ? input : ''
    if (key.escape || inputChar === '?' || (key.ctrl && inputChar === 'c')) {
      safeOnDone()
      return true
    }
    return undefined
  })

  const commandRows: ShortcutRow[] = [
    ...commands.map(command => ({
      label: command.trigger,
      detail: command.effect,
      tone: 'command' as const,
    })),
    { label: '@path', detail: 'insert file path', tone: 'command' },
  ]
  const inputRows: ShortcutRow[] = [
    { label: '! <cmd>', detail: 'run shell command', tone: 'command' },
    { label: '& <cmd>', detail: 'run in background', tone: 'command' },
    {
      label: `Ctrl/${shortcutModifier}+B`,
      detail: 'prefill /bash',
      tone: 'shortcut',
    },
    {
      label: modeCycleShortcut.displayText,
      detail: 'cycle tool permission mode',
      tone: 'shortcut',
    },
    { label: 'Double Esc', detail: 'clear input', tone: 'shortcut' },
    {
      label: 'Shift/Ctrl+Enter',
      detail: 'insert newline',
      tone: 'shortcut',
    },
  ]
  const systemRows: ShortcutRow[] = [
    {
      label: modelShortcut.trigger,
      detail: modelShortcut.effect,
      tone: 'shortcut',
    },
    {
      label: editorShortcut.trigger,
      detail: editorShortcut.effect,
      tone: 'shortcut',
    },
    {
      label: `${shortcutModifier}+T`,
      detail: 'thinking mode',
      tone: 'shortcut',
    },
    { label: 'Ctrl+O', detail: 'transcript output', tone: 'shortcut' },
    { label: 'Ctrl+T', detail: 'work tasks', tone: 'shortcut' },
    { label: 'Ctrl+_', detail: 'undo', tone: 'shortcut' },
    { label: 'Ctrl+V', detail: 'paste images', tone: 'shortcut' },
    ...(voiceShortcut ? [voiceShortcut] : []),
    { label: 'Esc', detail: 'close', tone: 'shortcut' },
  ]
  const narrowRows: ShortcutRow[] = [
    ...systemRows.slice(0, 2),
    ...inputRows.slice(2, 4),
    ...systemRows.slice(2, 4),
    voiceShortcut ??
      systemRows[6] ?? { label: 'Esc', detail: 'close', tone: 'shortcut' },
  ]
  const wide = layout.columns >= 110
  const gap = Math.max(2, layout.gap)
  const contentWidth = Math.max(1, layout.columns - layout.paddingX * 2 - 2)
  const narrowColumnWidth = Math.max(1, Math.floor((contentWidth - gap) / 2))
  const leftWidth = wide ? 30 : narrowColumnWidth
  const middleWidth = wide ? 31 : narrowColumnWidth

  return (
    <ScreenFrame
      title="Shortcuts"
      exitState={exitState}
      paddingX={layout.paddingX}
      paddingY={layout.paddingY}
      gap={layout.gap}
    >
      <Box flexDirection="row" gap={gap} paddingX={1}>
        <ShortcutColumn rows={commandRows} theme={theme} width={leftWidth} />
        <ShortcutColumn
          rows={wide ? inputRows : narrowRows}
          theme={theme}
          width={middleWidth}
        />
        {wide ? <ShortcutColumn rows={systemRows} theme={theme} /> : null}
      </Box>
    </ScreenFrame>
  )
}
