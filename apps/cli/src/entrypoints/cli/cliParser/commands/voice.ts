import type { Command } from '@commander-js/extra-typings'

import { getGlobalConfig } from '#core/utils/config'
import { resolveVoiceConfig } from '@kode/config'
import { readApiKey } from '#core/utils/config'

function printVoiceStatus(): void {
  const resolved = resolveVoiceConfig(getGlobalConfig().voice)
  if (!resolved.ok) {
    console.log(`Voice: configuration invalid — ${resolved.message}`)
    return
  }
  const config = resolved.config

  // The key may live in the environment or in Kode's owner-only credential
  // store (pasted via /voice config); report the effective availability.
  const apiKeyConfigured = Boolean(readApiKey(config.apiKeyEnv))

  console.log(
    [
      'Voice:',
      `  enabled: ${String(apiKeyConfigured)} (${config.apiKeyEnv})`,
      `  base-url: ${config.baseURL}`,
      `  asr-model: ${config.asrModel}`,
      `  tts-model: ${config.ttsModel}`,
      `  tts-voice: ${config.ttsVoice}`,
      `  language: ${config.language}`,
      `  speak-responses: ${String(config.speakResponses)}`,
      `  max-recording-seconds: ${String(config.maxRecordingSeconds)}`,
      `  max-reply-characters: ${String(config.maxReplyCharacters)}`,
      '',
      'Interactive: run /voice to record and send a voice prompt.',
      'Configure: run /voice config to open the settings screen.',
    ].join('\n'),
  )
}

export function registerVoiceCommands(program: Command): void {
  const voice = program
    .command('voice')
    .description('Voice input/output configuration status')

  voice
    .command('status')
    .description('Show voice configuration status (sanitized)')
    .action(() => {
      printVoiceStatus()
      process.exit(0)
    })
}
