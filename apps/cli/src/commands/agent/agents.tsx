import React from 'react'
import type { Command } from '../types'
import { AgentsUI } from './agents/ui'

export default {
  name: 'agents',
  description: 'Manage agent configurations',
  type: 'local-jsx' as const,
  isEnabled: true,
  isHidden: true,
  ui: { displayMode: 'fullscreen' as const },

  async call(onExit: (message?: string) => void) {
    return <AgentsUI onExit={onExit} />
  },

  userFacingName() {
    return 'agents'
  },
} satisfies Command
