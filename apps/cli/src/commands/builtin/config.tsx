import type { Command } from '../types'
import { ConfigScreen } from '#ui-ink/screens/overlays/ConfigScreen'
import * as React from 'react'

const config = {
  type: 'local-jsx',
  name: 'config',
  description: 'Open config panel',
  isEnabled: true,
  isHidden: true,
  ui: { displayMode: 'fullscreen' },
  async call(onDone) {
    return <ConfigScreen onClose={onDone} />
  },
  userFacingName() {
    return 'config'
  },
} satisfies Command

export default config
