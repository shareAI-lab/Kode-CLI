import type { Command } from '../types'
import * as React from 'react'
import { NotificationsScreen } from '#ui-ink/screens/overlays/NotificationsScreen'

const notifications = {
  type: 'local-jsx',
  name: 'notifications',
  description: 'View in-app notification history',
  isEnabled: true,
  isHidden: true,
  ui: { displayMode: 'fullscreen' },
  async call(onDone) {
    return <NotificationsScreen onDone={onDone} />
  },
  userFacingName() {
    return 'notifications'
  },
  aliases: ['notifs'],
} satisfies Command

export default notifications
