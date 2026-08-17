import type { Command } from '../types'

const note = {
  type: 'local',
  name: 'note',
  description: 'Save a note to AGENTS.md',
  argumentHint: '<text>',
  isEnabled: true,
  isHidden: true,
  disableNonInteractive: true,
  userFacingName() {
    return 'note'
  },
  async call() {
    return 'Use /note <text> directly in the prompt.'
  },
} satisfies Command

export default note
