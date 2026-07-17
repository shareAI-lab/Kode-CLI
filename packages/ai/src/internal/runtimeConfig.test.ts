import { afterEach, describe, expect, test } from 'bun:test'

import {
  addAiTotalCost,
  bindAiRuntime,
  getAiMainModelProfile,
  getAiStream,
  logAiError,
} from './runtimeConfig'

describe('bindAiRuntime host knobs', () => {
  afterEach(() => {
    bindAiRuntime(null)
  })

  test('defaults stream to true and profiles/errors/cost to no-ops', () => {
    bindAiRuntime(null)
    expect(getAiStream()).toBe(true)
    expect(getAiMainModelProfile()).toBeNull()
    expect(() => logAiError(new Error('x'))).not.toThrow()
    expect(() => addAiTotalCost(1, 2)).not.toThrow()
  })

  test('uses host bindings for stream, model, error, and cost', () => {
    const errors: unknown[] = []
    const costs: Array<[number, number]> = []
    bindAiRuntime({
      getStream: () => false,
      getMainModelProfile: () => ({ modelName: 'gpt-test', provider: 'openai' }),
      logError: error => {
        errors.push(error)
      },
      addToTotalCost: (cost, duration) => {
        costs.push([cost, duration])
      },
    })

    expect(getAiStream()).toBe(false)
    expect(getAiMainModelProfile()?.modelName).toBe('gpt-test')
    logAiError(new Error('boom'))
    addAiTotalCost(0.5, 12)
    expect(errors).toHaveLength(1)
    expect(costs).toEqual([[0.5, 12]])
  })
})
