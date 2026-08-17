import React from 'react'

import type { Command } from '../types'
import {
  DEFAULT_VOICE_CONFIG,
  getGlobalConfig,
  isExperimentalVoiceEnabled,
  redactVoiceConfig,
  resolveVoiceConfig,
  saveGlobalConfig,
} from '#core/utils/config'
import { VoiceScreen } from '#ui-ink/screens/overlays/VoiceScreen'
import { VoiceSubmissionError } from '#ui-ink/screens/overlays/VoiceScreen'
import { VoiceSettingsScreen } from '#ui-ink/screens/overlays/VoiceSettingsScreen'
import { interruptVoicePlayback } from '#cli-services/voice'
import {
  getOwnedBackgroundTaskSnapshot,
  listOwnedBackgroundTaskSnapshots,
  type BackgroundAgentTaskSnapshot,
} from '#core/tasks/backgroundRegistry'
import {
  BackgroundAgentGuidanceError,
  guideBackgroundAgentTask,
} from '#core/utils/backgroundTasks'
import { getCwd } from '#core/utils/state'
import { getEffectiveSessionId } from '#core/utils/sessionId'
import { getKodeAgentSessionId } from '#protocol/utils/kodeAgentSessionId'
import {
  resolveSessionMessageTarget,
  sendSessionMessage,
  SessionMessageError,
} from '@kode/protocol/sessionMessaging'

const USAGE = [
  'Usage:',
  '  /voice                         Record, transcribe, review, and send a voice prompt',
  '  /voice status                  Show sanitized voice status',
  '  /voice stop                    Stop the current spoken reply',
  '  /voice tasks                   Show live background Agent status',
  '  /voice task <task>             Inspect one background task',
  '  /voice guide [task]            Record reviewed guidance for a running Agent',
  '  /voice message <session>       Record a reviewed cross-session message',
  '  /voice config                  Open the keyboard-driven settings screen',
  '  /voice config set <field> <value>',
  '  /voice config reset',
  '',
  'Fields: base-url, api-key-env, asr-model, tts-model, tts-voice, language,',
  '        speak-responses, max-recording-seconds, max-reply-characters',
  '',
  'Example: /voice config set api-key-env MIMO_API_KEY',
  'Use /voice config to paste a MiMo key into Kode credential storage. Keys are never accepted through command arguments.',
].join('\n')

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000))
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}

function runningAgentTasks(): BackgroundAgentTaskSnapshot[] {
  return listOwnedBackgroundTaskSnapshots({
    cwd: getCwd(),
    sessionId: getKodeAgentSessionId(),
  }).filter(
    (task): task is BackgroundAgentTaskSnapshot =>
      task.taskType === 'local_agent' && task.status === 'running',
  )
}

export function resolveVoiceAgentTarget(
  identifier?: string,
): BackgroundAgentTaskSnapshot {
  const running = runningAgentTasks()
  const normalized = identifier?.trim().toLowerCase()
  if (!normalized) {
    if (running.length === 1) return running[0]!
    if (running.length === 0) {
      throw new VoiceSubmissionError(
        'No background Agent is currently running.',
      )
    }
    throw new VoiceSubmissionError(
      `More than one Agent is running. Choose one: ${running.map(task => task.taskId).join(', ')}`,
    )
  }
  const exact = running.find(task => task.taskId.toLowerCase() === normalized)
  if (exact) return exact
  const matches = running.filter(task =>
    task.taskId.toLowerCase().startsWith(normalized),
  )
  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) {
    throw new VoiceSubmissionError(
      `Agent ID prefix is ambiguous: ${identifier}`,
    )
  }
  const existing = getOwnedBackgroundTaskSnapshot({
    taskId: identifier!.trim(),
    cwd: getCwd(),
    sessionId: getKodeAgentSessionId(),
  })
  if (existing?.taskType === 'local_agent') {
    throw new VoiceSubmissionError(
      `Agent ${existing.taskId} is not running (status: ${existing.status}).`,
    )
  }
  throw new VoiceSubmissionError(`No running Agent found: ${identifier}`)
}

function resolveVoiceTaskTarget(identifier: string) {
  const normalized = identifier.trim().toLowerCase()
  if (!normalized) return null
  const tasks = listOwnedBackgroundTaskSnapshots({
    cwd: getCwd(),
    sessionId: getKodeAgentSessionId(),
  })
  const exact = tasks.find(task => task.taskId.toLowerCase() === normalized)
  if (exact) return exact
  const matches = tasks.filter(task =>
    task.taskId.toLowerCase().startsWith(normalized),
  )
  return matches.length === 1 ? matches[0]! : null
}

export function formatVoiceTaskStatus(identifier?: string): string {
  if (identifier?.trim()) {
    const task = resolveVoiceTaskTarget(identifier)
    if (!task) return `No task found with ID: ${identifier.trim()}`
    const elapsed = (task.completedAt ?? Date.now()) - task.startedAt
    return [
      `${task.taskType === 'local_agent' ? 'Agent' : 'Shell'} ${task.taskId}: ${task.status}`,
      task.description,
      `Runtime: ${formatDuration(elapsed)}`,
      ...(task.taskType === 'local_agent'
        ? [
            `Turns: ${task.turnCount ?? 0} · guidance: ${task.pendingGuidanceCount ?? 0} pending / ${task.appliedGuidanceCount ?? 0} applied`,
            task.lastGuidance
              ? `Latest guidance: ${task.lastGuidance.status} at ${new Date(task.lastGuidance.queuedAt).toISOString()}`
              : 'Latest guidance: none',
          ]
        : []),
    ].join('\n')
  }
  const tasks = listOwnedBackgroundTaskSnapshots({
    cwd: getCwd(),
    sessionId: getKodeAgentSessionId(),
  })
  if (tasks.length === 0) return 'No local background tasks.'
  return [
    `Local background tasks: ${tasks.filter(task => task.status === 'running').length} running / ${tasks.length} total`,
    ...tasks.slice(0, 50).map(task => {
      const control =
        task.taskType === 'local_agent'
          ? ` · ${task.turnCount ?? 0} turns · ${task.pendingGuidanceCount ?? 0} guidance pending`
          : ''
      return `${task.taskId} · ${task.taskType} · ${task.status}${control} · ${task.description}`
    }),
  ].join('\n')
}

function voiceSubmissionError(
  error: unknown,
  fallback: string,
): VoiceSubmissionError {
  if (
    error instanceof BackgroundAgentGuidanceError ||
    error instanceof SessionMessageError
  ) {
    return new VoiceSubmissionError(error.message)
  }
  return new VoiceSubmissionError(fallback)
}

function voiceStatus(): string {
  const resolved = resolveVoiceConfig(getGlobalConfig().voice)
  return resolved.ok
    ? JSON.stringify(redactVoiceConfig(resolved.config), null, 2)
    : `Voice configuration is invalid: ${resolved.message}`
}

function configValue(
  field: string,
  value: string,
): Record<string, unknown> | { error: string } {
  switch (field) {
    case 'api-key':
      return {
        error:
          'For security, paste the MiMo API key in /voice config. Command arguments are saved in shell history and are never accepted as credentials.',
      }
    case 'base-url':
      return { baseURL: value }
    case 'api-key-env':
      return { apiKeyEnv: value }
    case 'asr-model':
      return { asrModel: value }
    case 'tts-model':
      return { ttsModel: value }
    case 'tts-voice':
      return { ttsVoice: value }
    case 'language':
      return { language: value }
    case 'speak-responses':
      if (value === 'true') return { speakResponses: true }
      if (value === 'false') return { speakResponses: false }
      return { error: 'speak-responses must be true or false.' }
    case 'max-recording-seconds':
      if (!/^\d+$/u.test(value))
        return { error: 'max-recording-seconds must be an integer.' }
      return { maxRecordingSeconds: Number(value) }
    case 'max-reply-characters':
      if (!/^\d+$/u.test(value))
        return { error: 'max-reply-characters must be an integer.' }
      return { maxReplyCharacters: Number(value) }
    default:
      return { error: `Unknown voice configuration field: ${field}` }
  }
}

export function updateVoiceConfiguration(args: string): string {
  const tokens = args.trim().split(/\s+/u).filter(Boolean)
  if (tokens[0] !== 'config') return USAGE
  if (tokens.length === 1) return `${voiceStatus()}\n\n${USAGE}`
  if (tokens[1] === 'reset' && tokens.length === 2) {
    saveGlobalConfig({ ...getGlobalConfig(), voice: undefined })
    return 'Voice configuration was reset to the built-in MiMo defaults. Set the API key environment variable before recording.'
  }
  if (tokens[1] !== 'set' || tokens.length < 4) return USAGE
  const field = tokens[2]!
  const value = tokens.slice(3).join(' ').trim()
  const patch = configValue(field, value)
  if ('error' in patch) return `${patch.error}\n\n${USAGE}`
  const current = resolveVoiceConfig(getGlobalConfig().voice)
  if (!current.ok) {
    return `Existing voice configuration is invalid: ${current.message}\nUse /voice config reset before setting individual fields.`
  }
  const next = { ...current.config, ...patch }
  const validated = resolveVoiceConfig(next)
  if (!validated.ok)
    return `Voice configuration was not saved: ${validated.message}`
  saveGlobalConfig({ ...getGlobalConfig(), voice: validated.config })
  return `Voice configuration updated.\n${JSON.stringify(redactVoiceConfig(validated.config), null, 2)}`
}

const voice = {
  type: 'local-jsx',
  name: 'voice',
  description: 'Experimental: start a MiMo ASR/TTS voice conversation (macOS)',
  argumentHint: 'status|tasks|task|guide|message|config ...',
  // This is evaluated while the command registry initializes. Restart with
  // KODE_EXPERIMENTAL_VOICE=1 to expose /voice in discovery and execution.
  isEnabled: isExperimentalVoiceEnabled(),
  isHidden: false,
  disableNonInteractive: true,
  ui: { displayMode: 'fullscreen' },
  async call(onDone, _context, args = '') {
    const command = args.trim()
    if (command === 'config') {
      return React.createElement(VoiceSettingsScreen, { onDone })
    }
    if (command === 'tasks') {
      onDone(formatVoiceTaskStatus())
      return null
    }
    if (command.startsWith('task ')) {
      onDone(formatVoiceTaskStatus(command.slice('task '.length)))
      return null
    }
    if (command === 'guide' || command.startsWith('guide ')) {
      try {
        const task = resolveVoiceAgentTarget(
          command === 'guide' ? undefined : command.slice('guide '.length),
        )
        return React.createElement(VoiceScreen, {
          onDone,
          submission: {
            destination: `running Agent ${task.taskId}`,
            async submit(transcript: string) {
              try {
                const guidance = guideBackgroundAgentTask({
                  agentId: task.taskId,
                  body: transcript,
                })
                return `Voice guidance ${guidance.guidanceId} queued for ${task.taskId}. It will apply at the next model-turn boundary; use /voice task ${task.taskId} to verify status.`
              } catch (error) {
                throw voiceSubmissionError(
                  error,
                  'Could not queue guidance for the selected Agent.',
                )
              }
            },
          },
        })
      } catch (error) {
        onDone(
          error instanceof VoiceSubmissionError
            ? `${error.message}\n\n${USAGE}`
            : `Could not select a running Agent.\n\n${USAGE}`,
        )
        return null
      }
    }
    if (command.startsWith('message ')) {
      const identifier = command.slice('message '.length).trim()
      const cwd = getCwd()
      const senderSessionId = getEffectiveSessionId()
      try {
        const target = resolveSessionMessageTarget({
          cwd,
          currentSessionId: senderSessionId,
          identifier,
        })
        return React.createElement(VoiceScreen, {
          onDone,
          submission: {
            destination: `session ${target.label}`,
            async submit(transcript: string) {
              try {
                const message = await sendSessionMessage({
                  cwd,
                  senderSessionId,
                  targetSessionId: target.sessionId,
                  body: transcript,
                })
                return `Voice message ${message.messageId} queued for ${target.label}. Track it with /sm status ${message.messageId.slice(0, 8)}.`
              } catch (error) {
                throw voiceSubmissionError(
                  error,
                  'Could not queue the reviewed cross-session message.',
                )
              }
            },
          },
        })
      } catch (error) {
        onDone(
          error instanceof SessionMessageError
            ? `${error.message}\n\n${USAGE}`
            : `Could not resolve the target session.\n\n${USAGE}`,
        )
        return null
      }
    }
    if (command) {
      onDone(
        command === 'status'
          ? voiceStatus()
          : command === 'stop'
            ? interruptVoicePlayback()
              ? 'Stopped the current voice playback.'
              : 'No voice playback is active.'
            : updateVoiceConfiguration(args),
      )
      return null
    }
    return React.createElement(VoiceScreen, { onDone })
  },
  userFacingName() {
    return 'voice'
  },
} satisfies Command

export { DEFAULT_VOICE_CONFIG, USAGE }
export default voice
