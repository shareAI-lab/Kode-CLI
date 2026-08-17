import React from 'react'
import type { Command } from '../types'
import { ModelStatusDisplay } from '#ui-ink/components/ModelStatusDisplay'

const modelstatus: Command = {
  name: 'modelstatus',
  description: 'Display current model configuration and status',
  aliases: ['ms', 'model-status'],
  isEnabled: true,
  isHidden: true,
  ui: { displayMode: 'fullscreen' },
  userFacingName() {
    return 'modelstatus'
  },
  type: 'local-jsx',
  call(onDone) {
    return Promise.resolve(<ModelStatusDisplay onClose={onDone} />)
  },
}

export default modelstatus
