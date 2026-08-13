import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  clearSessionApiKey,
  getGlobalConfig,
  readVoiceApiKey,
  resolveVoiceConfig,
} from '#core/utils/config'
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
    if (harness.getOutput().includes(expected)) return
    await harness.wait(20)
  }
  throw new Error(`Timed out waiting for ${expected}: ${harness.getOutput()}`)
}

describe('TUI E2E: reviewed voice control delivery', () => {
  let apiKeyEnv = 'MIMO_API_KEY'
  let previousApiKey: string | undefined
  let previousVoiceFeatureFlag: string | undefined

  beforeEach(() => {
    const resolved = resolveVoiceConfig(getGlobalConfig().voice)
    if (!resolved.ok) throw new Error(resolved.message)
    apiKeyEnv = resolved.config.apiKeyEnv
    previousApiKey = process.env[apiKeyEnv]
    previousVoiceFeatureFlag = process.env.KODE_EXPERIMENTAL_VOICE
    process.env[apiKeyEnv] = 'test-key'
    process.env.KODE_EXPERIMENTAL_VOICE = '1'
  })

  afterEach(async () => {
    await harnessManager.cleanup()
    mock.restore()
    if (previousApiKey === undefined) delete process.env[apiKeyEnv]
    else process.env[apiKeyEnv] = previousApiKey
    if (previousVoiceFeatureFlag === undefined) {
      delete process.env.KODE_EXPERIMENTAL_VOICE
    } else {
      process.env.KODE_EXPERIMENTAL_VOICE = previousVoiceFeatureFlag
    }
  })

  test('opens a voice conversation from the F10 shortcut', async () => {
    const { REPL } = await import('#ui-ink/screens/REPL/REPL')
    const h = createInkTestHarness(
      <KeypressProvider>
        <REPL
          commands={[]}
          initialPrompt={undefined}
          messageLogName={`voice-shortcut-${Date.now()}`}
          shouldShowPromptInput={true}
          tools={[]}
          verbose={false}
        />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(80)
    h.stdin.write('\u001b[21~')
    await waitForOutput(h, 'Voice conversation')
    expect(h.getOutput()).toContain('Press Enter or F10 to begin recording')
  })

  test('records, streams a transcript, reviews it, then guides the selected Agent', async () => {
    mock.module('@kode/runtime', () => ({
      startMacOSVoiceRecording: async () => ({
        stop: async () => ({
          bytes: new Uint8Array([1, 2, 3]),
          mimeType: 'audio/wav',
          durationMs: 500,
        }),
        cancel: async () => {},
      }),
    }))
    mock.module('@kode/ai', () => ({
      VoiceConfigurationError: class VoiceConfigurationError extends Error {},
      createMiMoVoiceProvider: () => ({
        async *transcribeStream() {
          yield 'Prioritize '
          yield 'the cancellation race.'
        },
      }),
    }))
    mock.module('#cli-services/voice', () => ({
      interruptVoicePlayback: () => false,
    }))

    const submitted: string[] = []
    let doneResult: unknown = null
    const { VoiceScreen } = await import('#ui-ink/screens/overlays/VoiceScreen')
    const h = createInkTestHarness(
      <KeypressProvider>
        <VoiceScreen
          onDone={result => {
            doneResult = result
          }}
          submission={{
            destination: 'running Agent agent-1',
            async submit(transcript) {
              submitted.push(transcript)
              return 'Guidance queued.'
            },
          }}
        />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await waitForOutput(h, 'Press Enter or F10 to begin recording')
    h.stdin.write('\u001b[21~')
    await waitForOutput(h, '● Listening')
    h.stdin.write('\u001b[21~')
    await waitForOutput(h, 'Prioritize the cancellation race.')
    await waitForOutput(h, 'send it to running Agent agent-1')
    // The test harness writes transcript-sized chunks like a paste. Let the
    // input's paste guard settle before the explicit submit key.
    await h.wait(100)
    h.stdin.write('\r')
    await h.wait(80)

    expect(submitted).toEqual(['Prioritize the cancellation race.'])
    expect(doneResult).toBe('Guidance queued.')
  })

  test('opens credential settings from the error and starts recording after save', async () => {
    const previousConfigDir = process.env.KODE_CONFIG_DIR
    const credentialRoot = mkdtempSync(join(tmpdir(), 'kode-voice-recovery-'))
    const directApiKey = 'mimo-recovery-test-key'
    let recordingStarts = 0
    process.env.KODE_CONFIG_DIR = credentialRoot
    delete process.env[apiKeyEnv]
    clearSessionApiKey(apiKeyEnv)

    mock.module('@kode/runtime', () => ({
      startMacOSVoiceRecording: async () => {
        recordingStarts += 1
        return {
          stop: async () => ({
            bytes: new Uint8Array([1, 2, 3]),
            mimeType: 'audio/wav',
            durationMs: 500,
          }),
          cancel: async () => {},
        }
      },
    }))
    mock.module('@kode/ai', () => ({
      VoiceConfigurationError: class VoiceConfigurationError extends Error {},
      createMiMoVoiceProvider: () => ({
        async *transcribeStream() {
          yield 'Configured voice input.'
        },
      }),
    }))
    mock.module('#cli-services/voice', () => ({
      interruptVoicePlayback: () => false,
    }))

    try {
      const { VoiceScreen } =
        await import('#ui-ink/screens/overlays/VoiceScreen')
      const h = createInkTestHarness(
        <KeypressProvider>
          <VoiceScreen onDone={() => {}} />
        </KeypressProvider>,
      )
      harnessManager.track(h)

      await waitForOutput(h, 'Press Enter or F10 to begin recording')
      h.stdin.write('\r')
      await waitForOutput(h, 'Press Enter to open Voice settings')
      expect(h.getOutput()).toContain('Enter opens settings')
      expect(h.getOutput()).not.toContain('/voice config opens settings')

      h.clearOutput()
      h.stdin.write('\r')
      await waitForOutput(h, '↑/↓ select')
      expect(h.getOutput()).toContain('MiMo API key: not configured')

      await h.wait(80)
      h.stdin.write('\r')
      await h.wait(80)
      h.stdin.write(directApiKey)
      await h.wait(100)
      expect(h.getOutput()).not.toContain(directApiKey)
      h.stdin.write('\r')

      await waitForOutput(h, '● Listening')
      expect(recordingStarts).toBe(1)
      const resolved = resolveVoiceConfig(getGlobalConfig().voice)
      if (!resolved.ok) throw new Error(resolved.message)
      expect(readVoiceApiKey(resolved.config)).toBe(directApiKey)
    } finally {
      clearSessionApiKey(apiKeyEnv)
      if (previousConfigDir === undefined) delete process.env.KODE_CONFIG_DIR
      else process.env.KODE_CONFIG_DIR = previousConfigDir
      rmSync(credentialRoot, { recursive: true, force: true })
    }
  })
})
