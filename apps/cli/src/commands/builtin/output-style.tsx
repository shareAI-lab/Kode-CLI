import React, { useMemo, useRef } from 'react'
import { Box, Text } from 'ink'
import chalk from 'chalk'
import type { Command } from '../types'
import { Select } from '#ui-ink/components/CustomSelect/select'
import { getTheme } from '#core/utils/theme'
import { ScreenFrame } from '#ui-ink/primitives/layout/ScreenFrame'
import { useScreenLayout } from '#ui-ink/primitives/layout/useScreenLayout'
import {
  DEFAULT_OUTPUT_STYLE,
  getAvailableOutputStyles,
  getCurrentOutputStyle,
  resolveOutputStyleName,
  setCurrentOutputStyle,
} from '#cli-services/outputStyles'
import { useKeypress } from '#ui-ink/hooks/useKeypress'

const HELP_ARGS = new Set(['help', '-h', '--help'])
const CURRENT_ARGS = new Set(['?', 'current'])

function normalizeStyleName(value: string): string {
  return value.trim()
}

function OutputStyleMenu({
  onDone,
}: {
  onDone: (result?: string) => void
}): React.ReactNode {
  const theme = getTheme()
  const layout = useScreenLayout()
  const doneRef = useRef(false)

  const styles = useMemo(() => getAvailableOutputStyles(), [])
  const styleNames = useMemo(() => {
    const names = Object.keys(styles)
    return names.sort((a, b) => {
      if (a === DEFAULT_OUTPUT_STYLE && b !== DEFAULT_OUTPUT_STYLE) return -1
      if (b === DEFAULT_OUTPUT_STYLE && a !== DEFAULT_OUTPUT_STYLE) return 1
      return a.localeCompare(b)
    })
  }, [styles])

  const rawCurrentStyle = getCurrentOutputStyle()
  const resolvedCurrentStyle =
    resolveOutputStyleName(rawCurrentStyle) ?? DEFAULT_OUTPUT_STYLE

  const finish = (msg?: string) => {
    if (doneRef.current) return
    doneRef.current = true
    onDone(msg)
  }

  useKeypress((_input, key) => {
    if (key.escape) {
      finish(`Kept output style as ${chalk.bold(rawCurrentStyle)}`)
      return true
    }
    return undefined
  })

  return (
    <ScreenFrame
      title="Output Style"
      paddingX={layout.paddingX}
      paddingY={layout.paddingY}
      gap={layout.gap}
    >
      <Box flexDirection="column" gap={layout.gap}>
        <Text dimColor wrap="truncate-end">
          Current: {resolvedCurrentStyle}
        </Text>
        <Text dimColor wrap="truncate-end">
          Choose how Kode formats assistant output (verbosity, structure, etc).
        </Text>

        <Select
          focusScope="output-style"
          options={styleNames.map(name => ({ label: name, value: name }))}
          defaultValue={resolvedCurrentStyle}
          visibleOptionCount={Math.min(12, Math.max(5, styleNames.length))}
          onChange={value => {
            const next = normalizeStyleName(value)
            setCurrentOutputStyle(next)
            finish(`Set output style to ${chalk.bold(next)}`)
          }}
        />

        <Box marginTop={layout.tightLayout ? 0 : 1}>
          <Text dimColor wrap="truncate-end">
            ↑/↓ navigate · Enter select · Esc close
          </Text>
        </Box>
      </Box>
    </ScreenFrame>
  )
}

const outputStyle = {
  type: 'local-jsx',
  name: 'output-style',
  description: 'Set the output style directly or from a selection menu',
  isEnabled: true,
  isHidden: true,
  ui: { displayMode: 'fullscreen' },
  argumentHint: '[style]',
  userFacingName() {
    return 'output-style'
  },
  async call(onDone, _context, args) {
    const raw = (args ?? '').trim()

    if (CURRENT_ARGS.has(raw)) {
      const current = getCurrentOutputStyle()
      onDone(`Current output style: ${current}`)
      return null
    }

    if (HELP_ARGS.has(raw)) {
      onDone(
        'Run /output-style to open the output style selection menu, or /output-style [styleName] to set the output style.',
      )
      return null
    }

    if (raw) {
      const resolved = resolveOutputStyleName(raw)
      if (!resolved) {
        onDone(`Invalid output style: ${raw}`)
        return null
      }
      setCurrentOutputStyle(resolved)
      onDone(`Set output style to ${chalk.bold(resolved)}`)
      return null
    }

    return <OutputStyleMenu onDone={onDone} />
  },
} satisfies Command

export default outputStyle
