import { describe, expect, test } from 'bun:test'

import { createGrokAuthService, selectGrokModels } from './grokLogin'

const INITIALIZATION_RESULT = {
  _meta: {
    modelState: {
      currentModelId: 'grok-4.5',
      availableModels: [
        {
          modelId: 'other-model',
          name: 'Other model',
          _meta: { reasoningEffort: 'medium' },
        },
        {
          modelId: 'grok-4.5',
          name: 'Grok 4.5',
          _meta: { reasoningEffort: 'high' },
        },
      ],
    },
  },
}

describe('Grok Build OAuth', () => {
  test('uses the authenticated ACP catalog rather than grok models output', async () => {
    let stopped = false
    const service = createGrokAuthService(
      () =>
        ({
          start: async () => {},
          stop: async () => {
            stopped = true
          },
          getInitializationResult: () => INITIALIZATION_RESULT,
        }) as any,
    )

    await expect(service.getStatus()).resolves.toEqual({
      kind: 'authenticated',
    })
    await expect(service.getAvailableModels()).resolves.toEqual([
      {
        model: 'grok-4.5',
        displayName: 'Grok 4.5',
        reasoningEffort: 'high',
      },
      {
        model: 'other-model',
        displayName: 'Other model',
        reasoningEffort: 'medium',
      },
    ])
    expect(stopped).toBe(true)
  })

  test('rejects malformed ACP model metadata', () => {
    expect(() => selectGrokModels({ _meta: {} })).toThrow(
      'Grok ACP did not return a model catalog',
    )
  })
})
