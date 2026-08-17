import type { Command } from '../types'

import React from 'react'

import { TerminalSetupScreen } from '#ui-ink/screens/overlays/TerminalSetupScreen'

const terminalSetup = {
  type: 'local-jsx',
  name: 'terminal-setup',
  description: 'Set up Shift+Enter / Option+Enter for multi-line input',
  isEnabled: true,
  isHidden: true,
  ui: { displayMode: 'fullscreen' },
  disableNonInteractive: true,
  async call(onDone) {
    return React.createElement(TerminalSetupScreen, { onDone })
  },
  userFacingName() {
    return 'terminal-setup'
  },
} satisfies Command

export default terminalSetup
