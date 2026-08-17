import { readVoiceApiKey, type VoiceConfig } from '@kode/config'

import {
  VoiceConfigurationError,
  VoiceProviderError,
  type VoiceAudioInput,
  type VoicePcmChunk,
  type VoiceProvider,
  type VoiceSynthesis,
} from './contracts'

const MIMO_MAX_INPUT_BYTES = 10 * 1024 * 1024
const MIMO_MAX_OUTPUT_BYTES = 24 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 60_000

/** Small injectable subset keeps provider tests independent from Bun's fetch extras. */
type FetchLike = (
  input: URL | RequestInfo,
  init?: RequestInit,
) => Promise<Response>

function mimeTypeForMiMo(mimeType: VoiceAudioInput['mimeType']): string {
  return mimeType === 'audio/wav' ? 'audio/wav' : 'audio/mpeg'
}

function apiEndpoint(baseURL: string): string {
  return new URL(
    'chat/completions',
    `${baseURL.replace(/\/$/u, '')}/`,
  ).toString()
}

function apiKey(config: VoiceConfig): string {
  const value = readVoiceApiKey(config)
  if (!value?.trim()) {
    throw new VoiceConfigurationError(
      `Voice is not configured: set ${config.apiKeyEnv} or save a MiMo key in /voice config.`,
    )
  }
  return value.trim()
}

function makeTimeoutSignal(signal?: AbortSignal): {
  signal: AbortSignal
  dispose: () => void
} {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    },
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readTextResponse(value: unknown): string {
  const choices = asRecord(value)?.choices
  if (!Array.isArray(choices)) {
    throw new VoiceProviderError('MiMo ASR returned an invalid response.')
  }
  const content = asRecord(asRecord(choices[0])?.message)?.content
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new VoiceProviderError('MiMo ASR returned an empty transcript.')
  }
  return content.trim()
}

function decodeAudioBase64(
  base64: string,
  maxBytes: number,
  invalidMessage: string,
): Uint8Array {
  // Buffer.from silently accepts malformed base64. Reject it first so a broken
  // provider response cannot turn into an empty/surprising audio file.
  if (
    base64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(base64) ||
    (base64.indexOf('=') !== -1 && base64.indexOf('=') < base64.length - 2)
  ) {
    throw new VoiceProviderError(invalidMessage)
  }
  const bytes = new Uint8Array(Buffer.from(base64, 'base64'))
  if (bytes.length === 0 || bytes.length > maxBytes) {
    throw new VoiceProviderError('MiMo TTS audio exceeded the safe size limit.')
  }
  return bytes
}

function readAudioResponse(value: unknown): Uint8Array {
  const choices = asRecord(value)?.choices
  if (!Array.isArray(choices)) {
    throw new VoiceProviderError('MiMo TTS returned an invalid response.')
  }
  const base64 = asRecord(
    asRecord(asRecord(choices?.[0])?.message)?.audio,
  )?.data
  if (typeof base64 !== 'string' || base64.length === 0) {
    throw new VoiceProviderError('MiMo TTS returned no audio data.')
  }
  return decodeAudioBase64(
    base64,
    MIMO_MAX_OUTPUT_BYTES,
    'MiMo TTS returned invalid audio data.',
  )
}

async function postMiMo(args: {
  config: VoiceConfig
  body: Record<string, unknown>
  signal?: AbortSignal
  fetchImpl: FetchLike
}): Promise<unknown> {
  const timeout = makeTimeoutSignal(args.signal)
  try {
    const response = await args.fetchImpl(apiEndpoint(args.config.baseURL), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'api-key': apiKey(args.config),
      },
      body: JSON.stringify(args.body),
      signal: timeout.signal,
    })
    if (!response.ok) {
      // Do not surface provider response bodies: proxies sometimes include
      // request headers and the key must never re-enter the transcript/logs.
      throw new VoiceProviderError(
        `MiMo voice request failed (HTTP ${response.status}).`,
      )
    }
    try {
      return await response.json()
    } catch {
      throw new VoiceProviderError('MiMo voice request returned invalid JSON.')
    }
  } catch (error) {
    if (
      error instanceof VoiceConfigurationError ||
      error instanceof VoiceProviderError
    ) {
      throw error
    }
    if (timeout.signal.aborted) {
      throw new VoiceProviderError(
        args.signal?.aborted
          ? 'Voice request was cancelled.'
          : 'MiMo voice request timed out.',
      )
    }
    throw new VoiceProviderError('MiMo voice request could not be completed.')
  } finally {
    timeout.dispose()
  }
}

async function openMiMoStream(args: {
  config: VoiceConfig
  body: Record<string, unknown>
  signal?: AbortSignal
  fetchImpl: FetchLike
}): Promise<{ response: Response; dispose: () => void }> {
  const timeout = makeTimeoutSignal(args.signal)
  try {
    const response = await args.fetchImpl(apiEndpoint(args.config.baseURL), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'api-key': apiKey(args.config),
      },
      body: JSON.stringify({ ...args.body, stream: true }),
      signal: timeout.signal,
    })
    if (!response.ok) {
      timeout.dispose()
      throw new VoiceProviderError(
        `MiMo voice request failed (HTTP ${response.status}).`,
      )
    }
    if (!response.body) {
      timeout.dispose()
      throw new VoiceProviderError('MiMo voice streaming response has no body.')
    }
    return { response, dispose: timeout.dispose }
  } catch (error) {
    timeout.dispose()
    if (
      error instanceof VoiceConfigurationError ||
      error instanceof VoiceProviderError
    ) {
      throw error
    }
    if (timeout.signal.aborted) {
      throw new VoiceProviderError(
        args.signal?.aborted
          ? 'Voice request was cancelled.'
          : 'MiMo voice request timed out.',
      )
    }
    throw new VoiceProviderError('MiMo voice request could not be completed.')
  }
}

async function* streamSseJson(response: Response): AsyncGenerator<unknown> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      buffer += decoder.decode(next.value, { stream: true })
      while (true) {
        const separator = buffer.search(/\r?\n\r?\n/u)
        if (separator < 0) break
        const event = buffer.slice(0, separator)
        buffer = buffer.slice(separator).replace(/^\r?\n\r?\n/u, '')
        const data = event
          .split(/\r?\n/u)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart())
          .join('\n')
        if (!data || data === '[DONE]') continue
        try {
          yield JSON.parse(data)
        } catch {
          throw new VoiceProviderError(
            'MiMo voice streaming response contained invalid JSON.',
          )
        }
      }
    }
    const trailing = buffer.trim()
    if (trailing.startsWith('data:')) {
      const data = trailing.slice(5).trim()
      if (data && data !== '[DONE]') {
        try {
          yield JSON.parse(data)
        } catch {
          throw new VoiceProviderError(
            'MiMo voice streaming response contained invalid JSON.',
          )
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function readStreamTextDelta(value: unknown): string | null {
  const choices = asRecord(value)?.choices
  if (!Array.isArray(choices)) return null
  const content = asRecord(asRecord(choices[0])?.delta)?.content
  return typeof content === 'string' && content.length > 0 ? content : null
}

function readStreamAudioDelta(value: unknown): Uint8Array | null {
  const choices = asRecord(value)?.choices
  if (!Array.isArray(choices)) return null
  const data = asRecord(asRecord(asRecord(choices[0])?.delta)?.audio)?.data
  if (data === undefined || data === null) return null
  if (typeof data !== 'string') {
    throw new VoiceProviderError('MiMo TTS stream returned invalid audio data.')
  }
  return decodeAudioBase64(
    data,
    1_048_576,
    'MiMo TTS stream returned invalid audio data.',
  )
}

function rethrowStreamError(error: unknown, signal?: AbortSignal): never {
  if (
    error instanceof VoiceConfigurationError ||
    error instanceof VoiceProviderError
  ) {
    throw error
  }
  if (signal?.aborted)
    throw new VoiceProviderError('Voice request was cancelled.')
  throw new VoiceProviderError(
    'MiMo voice streaming request could not be completed.',
  )
}

export function createMiMoVoiceProvider(
  config: VoiceConfig,
  fetchImpl: FetchLike = fetch,
): VoiceProvider {
  return {
    async transcribe(input, signal) {
      if (
        input.bytes.length === 0 ||
        input.bytes.length > MIMO_MAX_INPUT_BYTES
      ) {
        throw new VoiceProviderError(
          'Recorded audio exceeded the 10 MB MiMo input limit.',
        )
      }
      const data = Buffer.from(input.bytes).toString('base64')
      const response = await postMiMo({
        config,
        signal,
        fetchImpl,
        body: {
          model: config.asrModel,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'input_audio',
                  input_audio: {
                    data: `data:${mimeTypeForMiMo(input.mimeType)};base64,${data}`,
                  },
                },
              ],
            },
          ],
          asr_options: { language: config.language },
        },
      })
      return readTextResponse(response)
    },

    async *transcribeStream(input, signal) {
      if (
        input.bytes.length === 0 ||
        input.bytes.length > MIMO_MAX_INPUT_BYTES
      ) {
        throw new VoiceProviderError(
          'Recorded audio exceeded the 10 MB MiMo input limit.',
        )
      }
      const data = Buffer.from(input.bytes).toString('base64')
      const stream = await openMiMoStream({
        config,
        signal,
        fetchImpl,
        body: {
          model: config.asrModel,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'input_audio',
                  input_audio: {
                    data: `data:${mimeTypeForMiMo(input.mimeType)};base64,${data}`,
                  },
                },
              ],
            },
          ],
          asr_options: { language: config.language },
        },
      })
      let receivedText = false
      try {
        for await (const payload of streamSseJson(stream.response)) {
          const delta = readStreamTextDelta(payload)
          if (!delta) continue
          receivedText = true
          yield delta
        }
      } catch (error) {
        rethrowStreamError(error, signal)
      } finally {
        stream.dispose()
      }
      if (!receivedText) {
        throw new VoiceProviderError('MiMo ASR returned an empty transcript.')
      }
    },

    async synthesize(text, signal): Promise<VoiceSynthesis> {
      const content = text.trim()
      if (!content)
        throw new VoiceProviderError('No text is available to synthesize.')
      if (content.length > config.maxReplyCharacters) {
        throw new VoiceProviderError(
          `Reply exceeds the configured ${config.maxReplyCharacters}-character voice limit.`,
        )
      }
      const response = await postMiMo({
        config,
        signal,
        fetchImpl,
        body: {
          model: config.ttsModel,
          messages: [{ role: 'assistant', content }],
          audio: { format: 'wav', voice: config.ttsVoice },
        },
      })
      return { bytes: readAudioResponse(response), mimeType: 'audio/wav' }
    },

    async *synthesizeStream(text, signal): AsyncGenerator<VoicePcmChunk> {
      const content = text.trim()
      if (!content)
        throw new VoiceProviderError('No text is available to synthesize.')
      if (content.length > config.maxReplyCharacters) {
        throw new VoiceProviderError(
          `Reply exceeds the configured ${config.maxReplyCharacters}-character voice limit.`,
        )
      }
      const stream = await openMiMoStream({
        config,
        signal,
        fetchImpl,
        body: {
          model: config.ttsModel,
          messages: [{ role: 'assistant', content }],
          audio: { format: 'pcm16', voice: config.ttsVoice },
        },
      })
      let receivedAudio = false
      try {
        for await (const payload of streamSseJson(stream.response)) {
          const bytes = readStreamAudioDelta(payload)
          if (!bytes) continue
          receivedAudio = true
          yield { bytes, sampleRate: 24_000, channels: 1 }
        }
      } catch (error) {
        rethrowStreamError(error, signal)
      } finally {
        stream.dispose()
      }
      if (!receivedAudio) {
        throw new VoiceProviderError('MiMo TTS stream returned no audio data.')
      }
    },
  }
}

export const __miMoVoiceForTests = {
  readAudioResponse,
  readStreamAudioDelta,
  readStreamTextDelta,
  readTextResponse,
}
