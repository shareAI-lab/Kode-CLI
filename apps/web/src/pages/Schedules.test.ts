import { describe, expect, test } from 'bun:test'

import { parseEveryIntervalMs } from './Schedules'

describe('Schedules helpers', () => {
  test('parses supported interval strings only', () => {
    expect(parseEveryIntervalMs('30s')).toBe(30_000)
    expect(parseEveryIntervalMs('5m')).toBe(300_000)
    expect(parseEveryIntervalMs('1h')).toBe(3_600_000)
    expect(parseEveryIntervalMs('0s')).toBeNull()
    expect(parseEveryIntervalMs('5d')).toBeNull()
    expect(parseEveryIntervalMs('')).toBeNull()
  })
})
