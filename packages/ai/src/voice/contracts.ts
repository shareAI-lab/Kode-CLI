import type { VoiceConfig } from '@kode/config'

export type VoiceAudioInput = {
  bytes: Uint8Array
  mimeType: 'audio/wav' | 'audio/mpeg'
}

export type VoiceSynthesis = {
  bytes: Uint8Array
  mimeType: 'audio/wav'
}

export type VoicePcmChunk = {
  bytes: Uint8Array
  /** MiMo documents streaming TTS as 24 kHz, mono, little-endian PCM16. */
  sampleRate: 24_000
  channels: 1
}

export class VoiceConfigurationError extends Error {
  override name = 'VoiceConfigurationError'
}

export class VoiceProviderError extends Error {
  override name = 'VoiceProviderError'
}

export type VoiceProvider = {
  transcribe(input: VoiceAudioInput, signal?: AbortSignal): Promise<string>
  /** Emits confirmed ASR text deltas for a completed audio capture. */
  transcribeStream(
    input: VoiceAudioInput,
    signal?: AbortSignal,
  ): AsyncIterable<string>
  synthesize(text: string, signal?: AbortSignal): Promise<VoiceSynthesis>
  synthesizeStream(
    text: string,
    signal?: AbortSignal,
  ): AsyncIterable<VoicePcmChunk>
}

export type VoiceProviderFactory = (config: VoiceConfig) => VoiceProvider
