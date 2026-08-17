import type { Command } from '../types'
import * as React from 'react'
import { PluginsScreen } from '#ui-ink/screens/overlays/PluginsScreen'

const plugins = {
  type: 'local-jsx',
  name: 'plugins',
  description: 'Manage plugins',
  isEnabled: true,
  isHidden: true,
  ui: { displayMode: 'fullscreen' },
  async call(onDone) {
    return <PluginsScreen onDone={onDone} />
  },
  userFacingName() {
    return 'plugins'
  },
} satisfies Command

export default plugins
