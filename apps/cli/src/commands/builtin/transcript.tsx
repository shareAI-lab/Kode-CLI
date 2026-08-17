import type { Command } from '../types'
import * as React from 'react'
import { TranscriptScreen } from '#ui-ink/screens/overlays/TranscriptScreen'

const transcript = {
  type: 'local-jsx',
  name: 'transcript',
  description: 'View and scroll the current conversation transcript',
  isEnabled: true,
  isHidden: true,
  ui: { displayMode: 'fullscreen' },
  async call(onDone, context) {
    const label = `${context.options?.messageLogName ?? 'conversation'}${
      typeof context.options?.forkNumber === 'number'
        ? `-${context.options.forkNumber}`
        : ''
    }`
    return <TranscriptScreen onDone={onDone} label={label} />
  },
  userFacingName() {
    return 'transcript'
  },
  aliases: ['history'],
} satisfies Command

export default transcript
