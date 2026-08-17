import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import React from 'react'
import { KeypressProvider } from '#ui-ink/contexts/KeypressContext'
import { createInkHarnessManager, createInkTestHarness } from './inkTestHarness'

const harnessManager = createInkHarnessManager()

afterEach(async () => {
  await harnessManager.cleanup()
  mock.restore()
})

describe('TUI E2E regression (Ink render): Model discovery', () => {
  test('leaving credential setup ignores a late model discovery response', async () => {
    let resolveModels:
      | ((models: Array<{ model: string; provider: 'custom-openai' }>) => void)
      | undefined
    const apiKeyEnv = 'CUSTOM_OPENAI_API_KEY'
    const previousApiKey = process.env[apiKeyEnv]
    const previousConfigDirectory = process.env.KODE_CONFIG_DIR
    const configDirectory = mkdtempSync(join(tmpdir(), 'kode-model-fetch-'))
    process.env[apiKeyEnv] = 'test-key'
    process.env.KODE_CONFIG_DIR = configDirectory

    try {
      mock.module(
        '#ui-ink/components/ModelSelector/flow/modelFetchers',
        () => ({
          fetchCustomOpenAIModels: () =>
            new Promise<Array<{ model: string; provider: 'custom-openai' }>>(
              resolve => {
                resolveModels = resolve
              },
            ),
        }),
      )

      const { ModelSelector } =
        await import('#ui-ink/components/ModelSelector/ModelSelector')

      const h = createInkTestHarness(
        <KeypressProvider>
          <ModelSelector initialProvider="custom-openai" onDone={() => {}} />
        </KeypressProvider>,
      )
      harnessManager.track(h)

      await h.wait(75)
      h.stdin.write('\t')
      await h.wait(50)
      expect(h.getOutput()).toContain('Discovering available models')
      expect(resolveModels).toBeDefined()

      h.stdin.write('\x1b')
      await h.wait(100)
      expect(h.getOutput()).toContain('Provider Selection')

      if (!resolveModels) throw new Error('Model discovery did not start')
      resolveModels([{ model: 'late-model', provider: 'custom-openai' }])
      await h.wait(75)

      expect(h.getOutput()).toContain('Provider Selection')
      expect(h.getOutput()).not.toContain('late-model')
    } finally {
      if (previousApiKey === undefined) delete process.env[apiKeyEnv]
      else process.env[apiKeyEnv] = previousApiKey
      if (previousConfigDirectory === undefined)
        delete process.env.KODE_CONFIG_DIR
      else process.env.KODE_CONFIG_DIR = previousConfigDirectory
      rmSync(configDirectory, { recursive: true, force: true })
    }
  })
})
