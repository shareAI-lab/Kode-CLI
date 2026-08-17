import type { Command } from '../types'

import React from 'react'

import { TasksScreen } from '#ui-ink/screens/overlays/TasksScreen'

const tasks = {
  type: 'local-jsx',
  name: 'tasks',
  description: 'Inspect local background tasks (agents and shells)',
  isEnabled: true,
  isHidden: true,
  ui: { displayMode: 'fullscreen' },
  disableNonInteractive: true,
  aliases: ['task', 'bashes'],
  async call(onDone) {
    return React.createElement(TasksScreen, { onDone })
  },
  userFacingName() {
    return 'tasks'
  },
} satisfies Command

export default tasks
