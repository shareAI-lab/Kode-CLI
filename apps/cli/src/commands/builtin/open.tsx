import type { Command } from '../types'
import * as React from 'react'
import { OpenFileScreen } from '#ui-ink/screens/overlays/OpenFileScreen'

const open = {
  type: 'local-jsx',
  name: 'open',
  description: 'Browse project files and open in $EDITOR',
  isEnabled: true,
  isHidden: true,
  ui: { displayMode: 'fullscreen' },
  async call(onDone) {
    return <OpenFileScreen onDone={onDone} />
  },
  userFacingName() {
    return 'open'
  },
} satisfies Command

export default open
