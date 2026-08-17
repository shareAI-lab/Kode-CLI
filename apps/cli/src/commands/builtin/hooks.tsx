import type { Command } from '../types'

import React from 'react'

import { HooksScreen } from '#ui-ink/screens/overlays/HooksScreen'

const hooks = {
  type: 'local-jsx',
  name: 'hooks',
  description: 'Manage hook configurations for tool events',
  isEnabled: true,
  isHidden: true,
  ui: { displayMode: 'fullscreen' },
  disableNonInteractive: true,
  async call(onDone, context) {
    return React.createElement(HooksScreen, { context, onDone })
  },
  userFacingName() {
    return 'hooks'
  },
} satisfies Command

export default hooks
