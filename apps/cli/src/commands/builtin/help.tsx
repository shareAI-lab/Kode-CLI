import type { Command } from '../types'
import { HelpScreen } from '#ui-ink/screens/overlays/HelpScreen'
import * as React from 'react'

const help = {
  type: 'local-jsx',
  name: 'help',
  description: 'Show help and available commands',
  isEnabled: true,
  isHidden: false,
  ui: { displayMode: 'fullscreen' },
  async call(onDone, context, args) {
    const showAll = args?.trim().toLowerCase() === 'all'
    return (
      <HelpScreen
        commands={context.options?.commands || []}
        onDone={onDone}
        showAll={showAll}
      />
    )
  },
  userFacingName() {
    return 'help'
  },
} satisfies Command

export default help
