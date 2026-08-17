import type { Command } from '../types'
import * as React from 'react'
import { ConsoleScreen } from '#ui-ink/screens/overlays/ConsoleScreen'

const consoleCommand = {
  type: 'local-jsx',
  name: 'console',
  description: 'View captured stdout/stderr writes during TUI rendering',
  isEnabled: true,
  isHidden: true,
  ui: { displayMode: 'fullscreen' },
  async call(onDone) {
    return <ConsoleScreen onDone={onDone} />
  },
  userFacingName() {
    return 'console'
  },
} satisfies Command

export default consoleCommand
