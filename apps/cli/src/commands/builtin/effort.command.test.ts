import { describe, expect, test } from 'bun:test'

import type { ModelManager } from '#core/model/manager'
import type { ModelProfile } from '#core/utils/config'

import { setCurrentModelReasoningEffort } from './effort'

function makeProfile(overrides: Partial<ModelProfile> = {}): ModelProfile {
  return {
    name: 'Copilot Auto',
    provider: 'github-copilot',
    modelName: 'github-copilot:auto',
    externalModelId: 'auto',
    apiKey: '',
    maxTokens: 32_768,
    contextLength: 128_000,
    reasoningEffort: 'medium',
    isActive: true,
    createdAt: 1,
    ...overrides,
  }
}

function makeManager(profile: ModelProfile | null) {
  const setCalls: string[] = []
  const manager = {
    getModel: () => profile,
    getSupportedReasoningEfforts: () =>
      ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const,
    setReasoningEffort: (_pointer: 'main', effort: string) => {
      setCalls.push(effort)
      return profile
    },
  } as unknown as Pick<
    ModelManager,
    'getModel' | 'getSupportedReasoningEfforts' | 'setReasoningEffort'
  >
  return { manager, setCalls }
}

describe('/effort', () => {
  test('reports the current model strength and its supported values', () => {
    const { manager } = makeManager(makeProfile())

    expect(setCurrentModelReasoningEffort('', manager)).toContain(
      'Current reasoning effort for Copilot Auto: medium',
    )
  })

  test('persists a supported strength for the current model', () => {
    const { manager, setCalls } = makeManager(makeProfile())

    expect(setCurrentModelReasoningEffort('high', manager)).toBe(
      'Set reasoning effort for Copilot Auto to high.',
    )
    expect(setCalls).toEqual(['high'])
  })

  test('does not persist an unsupported strength', () => {
    const { manager, setCalls } = makeManager(makeProfile())

    expect(setCurrentModelReasoningEffort('turbo', manager)).toContain(
      "Invalid reasoning effort 'turbo'",
    )
    expect(setCalls).toEqual([])
  })
})
