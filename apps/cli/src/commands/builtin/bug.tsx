import type { Command } from '../types'
import { Bug } from '#ui-ink/components/Bug'
import * as React from 'react'
import { PRODUCT_NAME } from '#core/constants/product'

const bug = {
  type: 'local-jsx',
  name: 'bug',
  description: `Submit feedback about ${PRODUCT_NAME}`,
  isEnabled: true,
  isHidden: true,
  aliases: ['feedback'],
  ui: { displayMode: 'fullscreen' },
  async call(onDone) {
    return <Bug onDone={onDone} />
  },
  userFacingName() {
    return 'bug'
  },
} satisfies Command

export default bug
