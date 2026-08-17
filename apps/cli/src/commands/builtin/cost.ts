import type { Command } from '../types'
import { formatTotalCost } from '#core/cost-tracker'

const cost = {
  type: 'local',
  name: 'cost',
  description: 'Show the total cost and duration of the current session',
  isEnabled: true,
  isHidden: true,
  async call() {
    return formatTotalCost()
  },
  userFacingName() {
    return 'cost'
  },
} satisfies Command

export default cost
