import type { Command } from '../types'
import { getCwd } from '#core/utils/state'
import { getKodeAgentSessionId } from '#protocol/utils/kodeAgentSessionId'
import { appendSessionCustomTitleRecord } from '#protocol/utils/kodeAgentSessionLog'

const rename = {
  type: 'local',
  name: 'rename',
  description: 'Set a custom title for the current session',
  isEnabled: true,
  isHidden: true,
  userFacingName() {
    return 'rename'
  },
  async call(args, _context) {
    const customTitle = args.trim()
    if (!customTitle) return 'Usage: /rename <title>'

    appendSessionCustomTitleRecord({
      cwd: getCwd(),
      sessionId: getKodeAgentSessionId(),
      customTitle,
    })

    return `Session renamed to: ${customTitle}`
  },
} satisfies Command

export default rename
