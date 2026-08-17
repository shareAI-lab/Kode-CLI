import type { Command } from '../types'
import { ThemePickerScreen } from '#ui-ink/screens/overlays/ThemePickerScreen'
import * as React from 'react'

const theme = {
  type: 'local-jsx',
  name: 'theme',
  description: 'Change the theme',
  isEnabled: true,
  isHidden: true,
  ui: { displayMode: 'fullscreen' },
  async call(onDone) {
    return <ThemePickerScreen onDone={onDone} />
  },
  userFacingName() {
    return 'theme'
  },
} satisfies Command

export default theme
