import { performance } from 'node:perf_hooks'

import { createMiMoVoiceProvider } from '../packages/ai/src/voice/mimo'
import { DEFAULT_VOICE_CONFIG } from '../packages/config/src/voice'

const frameCount = Number(
  process.env.KODE_VOICE_STREAM_BENCHMARK_FRAMES ?? '1000',
)
if (
  !Number.isSafeInteger(frameCount) ||
  frameCount < 1 ||
  frameCount > 100_000
) {
  throw new Error(
    'KODE_VOICE_STREAM_BENCHMARK_FRAMES must be an integer from 1 to 100000.',
  )
}

const previousKey = process.env.KODE_VOICE_BENCHMARK_KEY
process.env.KODE_VOICE_BENCHMARK_KEY = 'benchmark-only-not-a-real-key'
try {
  const body = Array.from(
    { length: frameCount },
    () => 'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
  ).join('')
  const provider = createMiMoVoiceProvider(
    { ...DEFAULT_VOICE_CONFIG, apiKeyEnv: 'KODE_VOICE_BENCHMARK_KEY' },
    async () =>
      new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
  )
  const startedAt = performance.now()
  let received = 0
  for await (const delta of provider.transcribeStream({
    bytes: new Uint8Array([1, 2]),
    mimeType: 'audio/wav',
  })) {
    received += delta.length
  }
  const elapsedMs = performance.now() - startedAt
  if (received !== frameCount)
    throw new Error('SSE benchmark dropped transcript data.')
  console.log(
    JSON.stringify({
      benchmark: 'voice-asr-sse-parser',
      frames: frameCount,
      receivedCharacters: received,
      elapsedMs: Number(elapsedMs.toFixed(2)),
    }),
  )
} finally {
  if (previousKey === undefined) delete process.env.KODE_VOICE_BENCHMARK_KEY
  else process.env.KODE_VOICE_BENCHMARK_KEY = previousKey
}
