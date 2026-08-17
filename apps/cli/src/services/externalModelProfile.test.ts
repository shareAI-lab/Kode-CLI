import { describe, expect, test } from 'bun:test'

import { saveExternalRuntimeModelProfile } from './externalModelProfile'

describe('saveExternalRuntimeModelProfile', () => {
  test('keeps external credentials out of the persisted Kode profile', async () => {
    let profile: unknown
    let options: unknown
    const modelId = await saveExternalRuntimeModelProfile(
      {
        provider: 'github-copilot',
        model: 'gpt-5-codex',
        displayName: 'GPT-5-Codex',
        reasoningEffort: 'high',
      },
      false,
      () =>
        ({
          upsertModel: async (next: unknown, nextOptions: unknown) => {
            profile = next
            options = nextOptions
            return 'github-copilot:gpt-5-codex'
          },
        }) as any,
      (provider, options) => {
        expect(provider).toBe('github-copilot')
        expect(options).toEqual({ accountLabel: 'octocat', verifiedAt: 123 })
        return 'oauth:github-copilot'
      },
      { accountLabel: 'octocat', verifiedAt: 123 },
    )

    expect(modelId).toBe('github-copilot:gpt-5-codex')
    expect(profile).toMatchObject({
      provider: 'github-copilot',
      modelName: 'github-copilot:gpt-5-codex',
      externalModelId: 'gpt-5-codex',
      oauthCredentialId: 'oauth:github-copilot',
      apiKey: '',
    })
    expect(options).toEqual({ activateAsMain: false })
  })
})
