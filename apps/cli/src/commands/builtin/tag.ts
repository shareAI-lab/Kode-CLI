import type { Command } from '../types'
import { getCwd } from '#core/utils/state'
import { getKodeAgentSessionId } from '#protocol/utils/kodeAgentSessionId'
import { appendSessionTagRecord } from '#protocol/utils/kodeAgentSessionLog'

const tag = {
  type: 'local',
  name: 'tag',
  description: 'Set a tag for the current session',
  isEnabled: true,
  isHidden: true,
  userFacingName() {
    return 'tag'
  },
  async call(args, _context) {
    const value = args.trim()
    if (!value) return 'Usage: /tag <tag>'

    appendSessionTagRecord({
      cwd: getCwd(),
      sessionId: getKodeAgentSessionId(),
      tag: value,
    })

    return `Session tagged as: ${value}`
  },
} satisfies Command

export default tag
