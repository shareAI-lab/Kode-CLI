import { afterEach, describe, expect, test } from 'bun:test'

import {
  AgentConcurrencyLimitError,
  AgentSupervisor,
} from '#core/utils/agentSupervisor'

afterEach(() => {
  AgentSupervisor.__resetForTests()
})

describe('AgentSupervisor stress', () => {
  test('never admits more than the configured concurrency limit', async () => {
    const limit = 10
    const attempts = 100
    let admitted = 0
    let rejected = 0
    let peak = 0
    const leases: AgentSupervisor[] = []

    await Promise.all(
      Array.from({ length: attempts }, async (_, index) => {
        await Promise.resolve()
        try {
          const lease = AgentSupervisor.acquire(`stress-agent-${index}`, {
            concurrentAgentLimit: limit,
          })
          leases.push(lease)
          admitted += 1
          peak = Math.max(peak, AgentSupervisor.activeCount)
        } catch (error) {
          expect(error).toBeInstanceOf(AgentConcurrencyLimitError)
          rejected += 1
        }
      }),
    )

    expect(admitted).toBe(limit)
    expect(rejected).toBe(attempts - limit)
    expect(peak).toBe(limit)
    for (const lease of leases) lease.release()
    expect(AgentSupervisor.activeCount).toBe(0)
  })
})
