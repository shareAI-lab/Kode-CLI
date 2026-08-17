import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  clearSessionApiKey,
  DEFAULT_VOICE_CONFIG,
  storeVoiceApiKey,
} from '@kode/config'

import {
  createMiMoVoiceProvider,
  VoiceConfigurationError,
  VoiceProviderError,
} from './index'

const ENV_KEY = 'KODE_VOICE_TEST_KEY'
const previousKey = process.env[ENV_KEY]
const previousConfigDirectory = process.env.KODE_CONFIG_DIR
const temporaryDirectories: string[] = []

afterEach(() => {
  clearSessionApiKey(ENV_KEY)
  if (previousKey === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = previousKey
  if (previousConfigDirectory === undefined) delete process.env.KODE_CONFIG_DIR
  else process.env.KODE_CONFIG_DIR = previousConfigDirectory
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function config() {
  return { ...DEFAULT_VOICE_CONFIG, apiKeyEnv: ENV_KEY }
}

describe('MiMo voice adapter', () => {
  test('uses the documented ASR request shape without exposing the key', async () => {
    process.env[ENV_KEY] = 'do-not-log-me'
    let request: RequestInit | undefined
    const provider = createMiMoVoiceProvider(config(), async (_url, init) => {
      request = init
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '  继续刚才的任务  ' } }],
        }),
      )
    })

    await expect(
      provider.transcribe({
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: 'audio/wav',
      }),
    ).resolves.toBe('继续刚才的任务')

    expect(request?.method).toBe('POST')
    expect(request?.headers).toEqual({
      'content-type': 'application/json',
      'api-key': 'do-not-log-me',
    })
    const body = JSON.parse(String(request?.body))
    expect(body).toMatchObject({
      model: 'mimo-v2.5-asr',
      asr_options: { language: 'auto' },
    })
    expect(body.messages[0].content[0].input_audio.data).toBe(
      'data:audio/wav;base64,AQID',
    )
  })

  test('requires the key at request time and rejects malformed provider output', async () => {
    delete process.env[ENV_KEY]
    const provider = createMiMoVoiceProvider(
      config(),
      async () => new Response('{}'),
    )
    await expect(
      provider.transcribe({
        bytes: new Uint8Array([1]),
        mimeType: 'audio/wav',
      }),
    ).rejects.toBeInstanceOf(VoiceConfigurationError)

    process.env[ENV_KEY] = 'test-key'
    const malformed = createMiMoVoiceProvider(
      config(),
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { audio: { data: '***=' } } }],
          }),
        ),
    )
    await expect(malformed.synthesize('hello')).rejects.toBeInstanceOf(
      VoiceProviderError,
    )
  })

  test('uses an owner-only persisted MiMo credential when no environment key exists', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kode-mimo-credential-'))
    temporaryDirectories.push(directory)
    process.env.KODE_CONFIG_DIR = directory
    delete process.env[ENV_KEY]
    storeVoiceApiKey(config(), 'stored-mimo-key')
    let request: RequestInit | undefined
    const provider = createMiMoVoiceProvider(config(), async (_url, init) => {
      request = init
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '已保存' } }] }),
      )
    })

    await expect(
      provider.transcribe({
        bytes: new Uint8Array([1]),
        mimeType: 'audio/wav',
      }),
    ).resolves.toBe('已保存')
    expect(request?.headers).toEqual({
      'content-type': 'application/json',
      'api-key': 'stored-mimo-key',
    })
  })

  test('uses the documented non-streaming TTS request and decodes WAV bytes', async () => {
    process.env[ENV_KEY] = 'test-key'
    let body: Record<string, unknown> | undefined
    const provider = createMiMoVoiceProvider(config(), async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                audio: { data: Buffer.from('RIFF').toString('base64') },
              },
            },
          ],
        }),
      )
    })
    await expect(provider.synthesize('你好')).resolves.toMatchObject({
      mimeType: 'audio/wav',
      bytes: new Uint8Array(Buffer.from('RIFF')),
    })
    expect(body).toEqual({
      model: 'mimo-v2.5-tts',
      messages: [{ role: 'assistant', content: '你好' }],
      audio: { format: 'wav', voice: 'mimo_default' },
    })
  })

  test('streams ASR deltas through SSE for progressive transcript review', async () => {
    process.env[ENV_KEY] = 'test-key'
    let body: Record<string, unknown> | undefined
    const provider = createMiMoVoiceProvider(config(), async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return new Response(
        [
          'data: {"choices":[{"delta":{"content":"继续"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"检查"}}]}\n\n',
          'data: [DONE]\n\n',
        ].join(''),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const deltas: string[] = []
    for await (const delta of provider.transcribeStream({
      bytes: new Uint8Array([1, 2]),
      mimeType: 'audio/wav',
    })) {
      deltas.push(delta)
    }
    expect(deltas).toEqual(['继续', '检查'])
    expect(body).toMatchObject({ model: 'mimo-v2.5-asr', stream: true })
  })

  test('streams documented PCM16 TTS chunks for low-latency playback', async () => {
    process.env[ENV_KEY] = 'test-key'
    let body: Record<string, unknown> | undefined
    const provider = createMiMoVoiceProvider(config(), async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return new Response(
        [
          `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: Buffer.from([1, 2]).toString('base64') } } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: { audio: { data: Buffer.from([3, 4]).toString('base64') } } }] })}\n\n`,
          'data: [DONE]\n\n',
        ].join(''),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    })
    const chunks: number[][] = []
    for await (const chunk of provider.synthesizeStream('你好')) {
      expect(chunk).toMatchObject({ sampleRate: 24_000, channels: 1 })
      chunks.push([...chunk.bytes])
    }
    expect(chunks).toEqual([
      [1, 2],
      [3, 4],
    ])
    expect(body).toEqual({
      model: 'mimo-v2.5-tts',
      messages: [{ role: 'assistant', content: '你好' }],
      audio: { format: 'pcm16', voice: 'mimo_default' },
      stream: true,
    })
  })
})
