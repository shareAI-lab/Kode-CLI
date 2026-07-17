import { describe, expect, test } from 'bun:test'

import { getCommand } from '../registry'

import plan from './plan'

describe('/plan', () => {
  test('resolves the concise /pl alias', () => {
    expect(plan.aliases).toContain('pl')
    expect(getCommand('pl', [plan])).toBe(plan)
  })
})
