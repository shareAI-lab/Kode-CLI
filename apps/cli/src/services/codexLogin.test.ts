import { describe, expect, test } from 'bun:test'

import {
  createCodexAuthService,
  parseCodexLoginStatus,
  selectCodexModels,
  selectCodexRecommendedSettings,
} from './codexLogin'

describe('parseCodexLoginStatus', () => {
  test('recognizes an authenticated ChatGPT session', () => {
    expect(
      parseCodexLoginStatus({
        exitCode: 0,
        stdout: 'Logged in using ChatGPT',
        stderr: '',
      }),
    ).toEqual({ kind: 'authenticated' })
  })

  test('does not treat a negative status as authenticated', () => {
    expect(
      parseCodexLoginStatus({
        exitCode: 1,
        stdout: 'Not logged in',
        stderr: '',
      }),
    ).toEqual({ kind: 'unauthenticated' })
  })

  test('reports an unrecognized command result as unavailable', () => {
    expect(
      parseCodexLoginStatus({
        exitCode: 1,
        stdout: '',
        stderr: 'command failed',
      }),
    ).toEqual({ kind: 'unavailable' })
  })
})

describe('selectCodexRecommendedSettings', () => {
  test('selects the catalog default and its supported default effort', () => {
    expect(
      selectCodexRecommendedSettings({
        data: [
          {
            model: 'gpt-fast',
            displayName: 'GPT Fast',
            isDefault: false,
            defaultReasoningEffort: 'low',
            supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
          },
          {
            model: 'gpt-recommended',
            displayName: 'GPT Recommended',
            isDefault: true,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [
              { reasoningEffort: 'low' },
              { reasoningEffort: 'medium' },
              { reasoningEffort: 'high' },
            ],
          },
        ],
      }),
    ).toEqual({
      model: 'gpt-recommended',
      displayName: 'GPT Recommended',
      reasoningEffort: 'medium',
    })
  })

  test('falls back to the first usable visible model and safe effort', () => {
    expect(
      selectCodexRecommendedSettings({
        data: [
          {
            model: 'bad model',
            isDefault: true,
            defaultReasoningEffort: 'medium',
          },
          {
            model: 'gpt-safe',
            displayName: 'GPT Safe\nunsafe',
            isDefault: false,
            defaultReasoningEffort: 'unsupported',
            supportedReasoningEfforts: [
              { reasoningEffort: 'low' },
              { reasoningEffort: 'medium' },
            ],
          },
        ],
      }),
    ).toEqual({
      model: 'gpt-safe',
      displayName: 'gpt-safe',
      reasoningEffort: 'medium',
    })
  })

  test('rejects an unusable or malformed catalog', () => {
    expect(() => selectCodexRecommendedSettings({ data: [] })).toThrow(
      'usable recommended model',
    )
    expect(() => selectCodexRecommendedSettings({ models: [] })).toThrow(
      'model catalog',
    )
  })
})

describe('selectCodexModels', () => {
  test('places the account default first and preserves other safe models', () => {
    expect(
      selectCodexModels({
        data: [
          {
            model: 'gpt-fast',
            displayName: 'GPT Fast',
            isDefault: false,
            defaultReasoningEffort: 'low',
            supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
          },
          {
            model: 'gpt-main',
            displayName: 'GPT Main',
            isDefault: true,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
          },
        ],
      }),
    ).toEqual([
      {
        model: 'gpt-main',
        displayName: 'GPT Main',
        reasoningEffort: 'medium',
      },
      {
        model: 'gpt-fast',
        displayName: 'GPT Fast',
        reasoningEffort: 'low',
      },
    ])
  })
})

describe('createCodexAuthService', () => {
  test('loads the runtime recommendation and applies both settings atomically', async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const service = createCodexAuthService(async (method, params) => {
      calls.push({ method, params })
      if (method === 'model/list') {
        return {
          data: [
            {
              model: 'gpt-runtime-default',
              displayName: 'GPT Runtime Default',
              isDefault: true,
              defaultReasoningEffort: 'medium',
              supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
            },
          ],
        }
      }
      return { status: 'ok' }
    })

    const recommendation = await service.getRecommendedSettings()
    await service.applyRecommendedSettings(recommendation)

    expect(calls).toEqual([
      {
        method: 'model/list',
        params: { limit: 100, includeHidden: false },
      },
      {
        method: 'config/batchWrite',
        params: {
          edits: [
            {
              keyPath: 'model',
              value: 'gpt-runtime-default',
              mergeStrategy: 'replace',
            },
            {
              keyPath: 'model_reasoning_effort',
              value: 'medium',
              mergeStrategy: 'replace',
            },
          ],
          reloadUserConfig: false,
        },
      },
    ])
  })

  test('fails closed for unsafe settings and unsuccessful writes', async () => {
    let requestCount = 0
    const service = createCodexAuthService(async () => {
      requestCount += 1
      return { status: 'error' }
    })

    await expect(
      service.applyRecommendedSettings({
        model: 'gpt-safe\nmalicious',
        displayName: 'Unsafe',
        reasoningEffort: 'medium',
      }),
    ).rejects.toThrow('Invalid Codex recommended settings')
    expect(requestCount).toBe(0)

    await expect(
      service.applyRecommendedSettings({
        model: 'gpt-safe',
        displayName: 'Safe',
        reasoningEffort: 'medium',
      }),
    ).rejects.toThrow('did not apply')
    expect(requestCount).toBe(1)
  })
})
