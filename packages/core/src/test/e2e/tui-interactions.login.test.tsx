import { afterEach, describe, expect, test } from 'bun:test'
import React from 'react'

import { LoginScreen } from '#ui-ink/components/LoginScreen'
import { ExternalOAuthLoginScreen } from '#ui-ink/components/ExternalOAuthLoginScreen'
import { KeypressProvider } from '#ui-ink/contexts/KeypressContext'
import { createInkHarnessManager, createInkTestHarness } from './inkTestHarness'

const harnessManager = createInkHarnessManager()

async function waitForOutput(
  harness: ReturnType<typeof createInkTestHarness>,
  expected: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (harness.getOutput().includes(expected)) {
      // Ink can write a frame immediately before the matching input effect is
      // committed. Let that effect settle before the caller sends a key.
      await harness.wait(50)
      return
    }
    await harness.wait(20)
  }
  throw new Error(`Timed out waiting for login output: ${expected}`)
}

afterEach(async () => {
  await harnessManager.cleanup()
})

describe('TUI E2E regression (Ink render): login selector', () => {
  test('lets Codex users choose a runtime model before saving the profile', async () => {
    let done = false
    let resolveSave: (() => void) | undefined
    const saves: Array<{ activateAsMain: boolean; model: string }> = []
    const h = createInkTestHarness(
      <KeypressProvider>
        <LoginScreen
          onDone={() => {
            done = true
          }}
          codexAuth={{
            getStatus: async () => ({ kind: 'authenticated' as const }),
            startLogin: async () => {},
            getRecommendedSettings: async () => ({
              model: 'gpt-runtime-default',
              displayName: 'GPT Runtime Default',
              reasoningEffort: 'medium',
            }),
            applyRecommendedSettings: async () => {},
            getAvailableModels: async () => [
              {
                model: 'gpt-5.6-sol',
                displayName: 'GPT-5.6 Sol',
                reasoningEffort: 'medium',
              },
              {
                model: 'gpt-5.6-terra',
                displayName: 'GPT-5.6 Terra',
                reasoningEffort: 'high',
              },
            ],
          }}
          saveProfile={async (model, activateAsMain) => {
            saves.push({ activateAsMain, model: model.model })
            await new Promise<void>(resolve => {
              resolveSave = resolve
            })
            return `codex-oauth:${model.model}`
          }}
        />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await waitForOutput(h, 'Use the installed Codex CLI browser sign-in')
    h.stdin.write('\r')
    await waitForOutput(h, 'Already signed in.')

    h.stdin.write('\r')
    await waitForOutput(h, 'Choose a model to save in Kode:')
    expect(h.getOutput()).toContain('GPT-5.6 Sol (gpt-5.6-sol) · medium')
    expect(h.getOutput()).toContain('GPT-5.6 Terra (gpt-5.6-terra) · high')

    h.stdin.write('\u001B[B')
    h.stdin.write('\r')
    await waitForOutput(h, 'Use GPT-5.6 Terra as Kode’s main model now?')
    h.stdin.write('\r')
    await h.wait(50)
    expect(done).toBe(false)

    resolveSave?.()
    await waitForOutput(h, 'GPT-5.6 Terra is now Kode’s persisted main model.')
    expect(saves).toEqual([{ activateAsMain: true, model: 'gpt-5.6-terra' }])
    h.stdin.write('\r')
    await h.wait(20)
    expect(done).toBe(true)
  })

  test('OAuth model setup saves a Kode profile and explicitly switches the main model', async () => {
    let done = false
    const saves: Array<{ activateAsMain: boolean; model: string }> = []
    const savedProfiles: Array<{
      activateAsMain: boolean
      modelId: string
    }> = []
    const h = createInkTestHarness(
      <KeypressProvider>
        <ExternalOAuthLoginScreen
          provider="codex-oauth"
          title="Codex / ChatGPT OAuth"
          onDone={() => {
            done = true
          }}
          onCancel={() => {}}
          authService={{
            getStatus: async () => ({ kind: 'authenticated' as const }),
            startLogin: async () => {},
            getAvailableModels: async () => [
              {
                model: 'gpt-runtime-default',
                displayName: 'GPT Runtime Default',
                reasoningEffort: 'medium',
              },
            ],
          }}
          saveProfile={async (model, activateAsMain) => {
            saves.push({ activateAsMain, model: model.model })
            return 'codex-oauth:gpt-runtime-default'
          }}
          onProfileSaved={async (modelId, activateAsMain) => {
            savedProfiles.push({ modelId, activateAsMain })
          }}
        />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await waitForOutput(h, 'Already signed in.')
    h.stdin.write('\r')
    await waitForOutput(h, 'Choose a model to save in Kode:')
    expect(h.getOutput()).toContain(
      'GPT Runtime Default (gpt-runtime-default) · medium',
    )

    h.stdin.write('\r')
    await waitForOutput(h, 'Use GPT Runtime Default as Kode’s main model now?')
    h.stdin.write('\r')
    await waitForOutput(h, 'persisted main model.')
    expect(saves).toEqual([
      { activateAsMain: true, model: 'gpt-runtime-default' },
    ])
    expect(savedProfiles).toEqual([
      { activateAsMain: true, modelId: 'codex-oauth:gpt-runtime-default' },
    ])

    h.stdin.write('\r')
    await h.wait(20)
    expect(done).toBe(true)
  })

  test('OAuth model setup can save without switching Kode', async () => {
    const saves: boolean[] = []
    const h = createInkTestHarness(
      <KeypressProvider>
        <ExternalOAuthLoginScreen
          provider="github-copilot"
          title="GitHub Copilot OAuth"
          onDone={() => {}}
          onCancel={() => {}}
          authService={{
            getStatus: async () => ({ kind: 'authenticated' as const }),
            startLogin: async () => {},
            getAvailableModels: async () => [
              { model: 'gpt-5-codex', displayName: 'GPT-5-Codex' },
            ],
          }}
          saveProfile={async (_model, activateAsMain) => {
            saves.push(activateAsMain)
            return 'github-copilot:gpt-5-codex'
          }}
        />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await waitForOutput(h, 'Already signed in.')
    h.stdin.write('\r')
    await waitForOutput(h, 'Choose a model to save in Kode:')
    h.stdin.write('\r')
    await waitForOutput(h, 'Use GPT-5-Codex as Kode’s main model now?')
    h.stdin.write('\u001B[B')
    await h.wait(50)
    h.stdin.write('\r')
    await waitForOutput(h, 'current main model was kept.')
    expect(saves).toEqual([false])
  })

  test('opens GitHub Copilot OAuth from the login selector', async () => {
    const h = createInkTestHarness(
      <KeypressProvider>
        <LoginScreen
          onDone={() => {}}
          codexAuth={{
            getStatus: async () => ({ kind: 'authenticated' as const }),
            startLogin: async () => {},
            getRecommendedSettings: async () => ({
              model: 'gpt-runtime-default',
              displayName: 'GPT Runtime Default',
              reasoningEffort: 'medium',
            }),
            applyRecommendedSettings: async () => {},
          }}
          copilotAuth={{
            getStatus: async () => ({ kind: 'authenticated' as const }),
            startLogin: async () => {},
            getAvailableModels: async () => [
              { model: 'auto', displayName: 'Auto' },
            ],
          }}
        />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await waitForOutput(h, 'Use the installed Codex CLI browser sign-in')
    h.stdin.write('\u001B[B')
    await waitForOutput(h, 'official GitHub Copilot browser or device OAuth')
    h.stdin.write('\r')
    await waitForOutput(h, 'GitHub Copilot OAuth')
    await waitForOutput(h, 'Already signed in.')
  })

  test('opens the OpenAI API-key setup directly from the login selector', async () => {
    const h = createInkTestHarness(
      <KeypressProvider>
        <LoginScreen
          onDone={() => {}}
          codexAuth={{
            getStatus: async () => ({ kind: 'authenticated' as const }),
            startLogin: async () => {},
            getRecommendedSettings: async () => ({
              model: 'gpt-runtime-default',
              displayName: 'GPT Runtime Default',
              reasoningEffort: 'medium',
            }),
            applyRecommendedSettings: async () => {},
          }}
        />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await waitForOutput(h, 'Use the installed Codex CLI browser sign-in')
    h.stdin.write('\u001B[B')
    h.stdin.write('\u001B[B')
    h.stdin.write('\u001B[B')
    await waitForOutput(h, 'Configure an OpenAI model profile')
    h.stdin.write('\r')
    await waitForOutput(h, 'Credential Source / 凭据来源')

    const output = h.getOutput()
    expect(output).toContain('Credential Source / 凭据来源')
    expect(output).toContain(
      'Paste a key to save it in Kode credential storage.',
    )
  })
})
