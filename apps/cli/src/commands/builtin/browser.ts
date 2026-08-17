import type { Command } from '../types'

import { createDisabledBrowserAdapter } from '#core/browser'

function browserStatus(): string {
  const adapter = createDisabledBrowserAdapter()
  return [
    `Browser adapter: ${adapter.kind} (${adapter.isAvailable ? 'available' : 'unavailable'})`,
    'Browser automation is fail-closed.',
    'No navigation, click, typing, screenshot, or browser MCP call can run until an approved adapter is configured by the host.',
  ].join('\n')
}

const browser = {
  type: 'local',
  name: 'browser',
  description: 'Show browser automation safety status',
  argumentHint: '[status]',
  isEnabled: true,
  isHidden: true,
  disableNonInteractive: true,
  async call(args: string) {
    const action = args.trim().toLowerCase()
    if (
      !action ||
      action === 'status' ||
      action === 'help' ||
      action === '--help'
    ) {
      return browserStatus()
    }
    return `Unsupported browser action: ${action}\n\n${browserStatus()}`
  },
  userFacingName() {
    return 'browser'
  },
} satisfies Command

export default browser
