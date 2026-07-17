import { afterEach, describe, expect, test } from 'bun:test'

import {
  bindAiAdapterFactory,
  getAiAdapterFactory,
} from '../internal/adapterFactory'
import { ModelAdapterFactory } from './modelAdapterFactory'

describe('ModelAdapterFactory (ai-owned)', () => {
  afterEach(() => {
    bindAiAdapterFactory(undefined)
  })

  test('routes gpt-5 on official endpoint to Responses API', () => {
    expect(
      ModelAdapterFactory.shouldUseResponsesAPI({
        modelName: 'gpt-5',
        baseURL: 'https://api.openai.com/v1',
      }),
    ).toBe(true)
  })

  test('routes gpt-4o to Chat Completions', () => {
    expect(
      ModelAdapterFactory.shouldUseResponsesAPI({
        modelName: 'gpt-4o',
      }),
    ).toBe(false)
  })

  test('default adapter factory binding is the in-package factory', () => {
    bindAiAdapterFactory(undefined)
    const factory = getAiAdapterFactory()
    expect(factory).not.toBeNull()
    expect(
      factory!.shouldUseResponsesAPI({
        modelName: 'gpt-5',
        baseURL: 'https://api.openai.com/v1',
      }),
    ).toBe(true)
  })

  test('explicit null unbinds adapters (chat-only path)', () => {
    bindAiAdapterFactory(null)
    expect(getAiAdapterFactory()).toBeNull()
  })
})
