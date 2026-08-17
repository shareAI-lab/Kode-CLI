import type { AssistantMessage } from '#core/query'
import { getGlobalConfig, resolveVoiceConfig } from '#core/utils/config'
import { createMiMoVoiceProvider, VoiceConfigurationError } from '@kode/ai'
import {
  startMacOSPCMPlayback,
  startMacOSVoicePlayback,
  type ActiveVoicePCMPlayback,
  type NativeVoicePlayback,
} from '@kode/runtime'

let playbackTail: Promise<void> = Promise.resolve()
let playbackGeneration = 0
let activeSynthesis: AbortController | null = null
let activePlayback: NativeVoicePlayback | null = null
let activePcmPlayback: ActiveVoicePCMPlayback | null = null

/**
 * This is scoped to a voice-submitted user turn. It makes the main agent the
 * semantic arbiter of disfluency and context, while keeping policy and tool
 * approval in the existing conversation path rather than in an unsafe regex
 * command parser.
 */
export function getVoiceInputSystemPromptAdditions(): string[] {
  return [
    'This user message originated as an ASR transcript. Treat it as conversational language, not slash-command syntax.',
    'Resolve obvious filler, repetitions, and self-corrections from the conversation context, but never invent omitted targets, parameters, or destructive intent.',
    'Treat every message as a continuation of a conversation, not as a form to fill or a workflow to advance. Keep a tentative understanding of the current goal, confirmed facts, corrections, and open questions; revise it when the user explicitly changes direction.',
    'Reply naturally to the conversation first. Do not create an intent brief, checklist, or delegated task merely to acknowledge, discuss, compare, or refine an idea.',
    'If an ambiguity changes a write, external, or irreversible effect, ask one short clarifying question and preserve the stated intent. For a bounded safe read-only investigation, you may say what you will inspect and begin it without pretending the broader conversation is settled.',
    'Freeze a voice_intent only when moving from conversation to delegated execution. It must contain the normalized goal, explicit facts/constraints, bounded assumptions, and an empty unresolved_questions array. A correction or reversal from the user supersedes earlier wording only when it is explicit.',
    'For this voice turn, never call Task directly. Use TaskBatch only after the execution boundary is clear. Each subtask prompt must be self-contained and must not paste raw ASR wording.',
    'When the request contains several unrelated goals, name the separated goals and ask which to prioritize unless they are independently safe read-only investigations. Do not merge unrelated goals merely to reduce the number of agent calls.',
    'For actions that write, execute, publish, spend money, or affect external systems, retain the normal permission and confirmation flow. Do not treat spoken wording as pre-approval.',
    'When an execution brief contains several independent investigations, TaskBatch may dispatch only explicitly read-only agents in bounded parallelism. Keep all write-capable work serialized and preserve ordinary permissions.',
    'Only resume a previous agent when the user explicitly asks to continue it, its prior agent id is present in the conversation, and it is no longer running. The new execution brief is authoritative over its older transcript.',
    'Prefer a concise first sentence suitable for speech, then offer detail or begin only safe read-only investigation. Report concrete long-running work as progress rather than silence.',
  ]
}

function textFromAssistant(message: AssistantMessage): string {
  const content = message.message.content
  return typeof content === 'string'
    ? content
    : content
        .filter(block => block.type === 'text')
        .map(block => (block.type === 'text' ? block.text : ''))
        .join('\n')
}

/**
 * TTS should narrate an answer, never a tool payload or a pasted code block.
 * This deliberately errs on the side of silence for a reply that becomes empty.
 */
export function makeVoiceNarration(
  content: string,
  maxCharacters: number,
): string | null {
  const narration = content
    .replace(/```[\s\S]*?```/gu, ' ')
    .replace(
      /<(tool(?:_[\w-]+)?|local-command-[\w-]+|command-[\w-]+)[^>]*>[\s\S]*?<\/\1>/giu,
      ' ',
    )
    .replace(/<[^>]+>/gu, ' ')
    .replace(/!?(\[[^\]]*\])\([^)]*\)/gu, '$1')
    .replace(/^\s{0,3}(?:[-*+] |\d+\. |#{1,6}\s)/gmu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!narration) return null
  return narration.length <= maxCharacters
    ? narration
    : narration
        .slice(0, maxCharacters)
        .replace(/\s+\S*$/u, '')
        .trim() || null
}

/**
 * Stops current speech and invalidates every queued fragment. This is the
 * explicit barge-in primitive used by a new voice capture and /voice stop.
 */
export function interruptVoicePlayback(): boolean {
  const wasActive = Boolean(
    activeSynthesis || activePlayback || activePcmPlayback,
  )
  playbackGeneration += 1
  activeSynthesis?.abort()
  activeSynthesis = null
  activePlayback?.stop()
  activePlayback = null
  const pcmPlayback = activePcmPlayback
  activePcmPlayback = null
  void pcmPlayback?.cancel()
  return wasActive
}

async function playWavFallback(args: {
  narration: string
  generation: number
  controller: AbortController
}): Promise<void> {
  const resolved = resolveVoiceConfig(getGlobalConfig().voice)
  if (!resolved.ok) throw new VoiceConfigurationError(resolved.message)
  const provider = createMiMoVoiceProvider(resolved.config)
  for (const chunk of splitVoiceNarration(
    args.narration,
    Math.min(240, resolved.config.maxReplyCharacters),
  )) {
    const audio = await provider.synthesize(chunk, args.controller.signal)
    if (
      args.generation !== playbackGeneration ||
      args.controller.signal.aborted
    )
      return
    await enqueuePlayback({ generation: args.generation, bytes: audio.bytes })
  }
}

/** Split at natural punctuation so a long explanation starts speaking sooner. */
export function splitVoiceNarration(
  narration: string,
  maxChunkCharacters = 240,
): string[] {
  if (!Number.isSafeInteger(maxChunkCharacters) || maxChunkCharacters < 1) {
    throw new Error('maxChunkCharacters must be a positive integer.')
  }
  const sentences = narration.match(/[^。！？!?]+[。！？!?]?/gu) ?? [narration]
  const chunks: string[] = []
  let current = ''
  const push = () => {
    if (current.trim()) chunks.push(current.trim())
    current = ''
  }
  for (const sentence of sentences) {
    const normalized = sentence.trim()
    if (!normalized) continue
    if (normalized.length > maxChunkCharacters) {
      push()
      for (
        let start = 0;
        start < normalized.length;
        start += maxChunkCharacters
      ) {
        chunks.push(normalized.slice(start, start + maxChunkCharacters))
      }
      continue
    }
    if (
      current &&
      current.length + 1 + normalized.length > maxChunkCharacters
    ) {
      push()
    }
    current = current ? `${current} ${normalized}` : normalized
  }
  push()
  return chunks
}

function enqueuePlayback(args: {
  generation: number
  bytes: Uint8Array
}): Promise<void> {
  const next = playbackTail
    .catch(() => undefined)
    .then(async () => {
      if (args.generation !== playbackGeneration) return
      const playback = await startMacOSVoicePlayback(args.bytes)
      if (args.generation !== playbackGeneration) {
        playback.stop()
        await playback.completed
        return
      }
      activePlayback = playback
      try {
        await playback.completed
      } finally {
        if (activePlayback === playback) activePlayback = null
      }
    })
  playbackTail = next.catch(() => undefined)
  return next
}

/**
 * Speech is intentionally detached from the completed model turn. A provider,
 * network, or speaker failure must never alter its transcript or success state.
 */
export async function speakVoiceReply(
  message: AssistantMessage,
): Promise<void> {
  if (message.isApiErrorMessage) return
  const resolved = resolveVoiceConfig(getGlobalConfig().voice)
  if (!resolved.ok) throw new VoiceConfigurationError(resolved.message)
  if (!resolved.config.speakResponses) return
  const narration = makeVoiceNarration(
    textFromAssistant(message),
    resolved.config.maxReplyCharacters,
  )
  if (!narration) return
  interruptVoicePlayback()
  const generation = playbackGeneration
  const controller = new AbortController()
  activeSynthesis = controller
  const provider = createMiMoVoiceProvider(resolved.config)
  let receivedPcm = false
  let pcmPlayback: ActiveVoicePCMPlayback | null = null
  try {
    pcmPlayback = await startMacOSPCMPlayback({ sampleRate: 24_000 })
    activePcmPlayback = pcmPlayback
    for await (const chunk of provider.synthesizeStream(
      narration,
      controller.signal,
    )) {
      if (generation !== playbackGeneration || controller.signal.aborted) return
      receivedPcm = true
      await pcmPlayback.write(chunk.bytes)
    }
    if (generation === playbackGeneration && !controller.signal.aborted) {
      await pcmPlayback.finish()
    }
  } catch (error) {
    if (generation !== playbackGeneration || controller.signal.aborted) return
    // A provider/proxy that does not preserve SSE must not make spoken replies
    // disappear. If no audio began, use the bounded WAV path; never replay a
    // partial answer because that would duplicate what the user already heard.
    if (!receivedPcm) {
      await pcmPlayback?.cancel()
      if (activePcmPlayback === pcmPlayback) activePcmPlayback = null
      await playWavFallback({ narration, generation, controller })
      return
    }
    throw error
  } finally {
    if (activePcmPlayback === pcmPlayback) activePcmPlayback = null
    if (activeSynthesis === controller) activeSynthesis = null
    if (pcmPlayback && receivedPcm && generation !== playbackGeneration) {
      await pcmPlayback.cancel()
    }
  }
}

export const __voiceForTests = { enqueuePlayback, textFromAssistant }
