import type { Command } from '../types'
import { getMessagesGetter } from '#core/messages'
import type { Message } from '#core/query'
import { copyTextToClipboard } from '#cli-utils/clipboard'
import {
  buildTranscriptLines,
  extractTextFromMessageContent,
} from '#cli-utils/transcriptText'

function getLastMessageText(
  messages: Message[],
  role: 'assistant' | 'user',
): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]
    if (!msg || msg.type !== role) continue
    const text = extractTextFromMessageContent(msg.message?.content)
    if (text.trim()) return text
  }
  return null
}

function buildTranscriptText(messages: Message[]): string {
  return buildTranscriptLines(messages, { includeTools: false }).join('\n')
}

function buildTranscriptTextVerbose(messages: Message[]): string {
  return buildTranscriptLines(messages, { includeTools: true }).join('\n')
}

const copy = {
  type: 'local',
  name: 'copy',
  description: 'Copy assistant/user/transcript text to your clipboard',
  argumentHint: '[assistant|user|transcript [verbose]]',
  isEnabled: true,
  isHidden: true,
  async call(args: string) {
    const messages = getMessagesGetter()()
    const tokens = (args ?? '')
      .trim()
      .split(/\s+/)
      .map(t => t.trim())
      .filter(Boolean)
    const mode = (tokens[0] ?? '').toLowerCase()
    const flags = new Set(tokens.slice(1).map(t => t.toLowerCase()))
    const verbose = flags.has('verbose') || flags.has('--verbose') || false

    const text =
      mode === '' || mode === 'last' || mode === 'assistant'
        ? getLastMessageText(messages, 'assistant')
        : mode === 'user' || mode === 'last-user'
          ? getLastMessageText(messages, 'user')
          : mode === 'transcript' || mode === 'history' || mode === 'all'
            ? verbose
              ? buildTranscriptTextVerbose(messages)
              : buildTranscriptText(messages)
            : null

    if (!text) {
      if (
        mode === '' ||
        mode === 'last' ||
        mode === 'assistant' ||
        mode === 'user' ||
        mode === 'last-user'
      ) {
        return `No ${mode === 'user' || mode === 'last-user' ? 'user' : 'assistant'} output to copy yet.`
      }
      return 'Usage: /copy [assistant|user|transcript [verbose]]'
    }

    try {
      const result = await copyTextToClipboard(text)
      if (result.method === 'osc52' && result.truncated) {
        return 'Copied to clipboard (OSC 52, truncated).'
      }
      return 'Copied to clipboard.'
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `Failed to copy to clipboard: ${message}`
    }
  },
  userFacingName() {
    return 'copy'
  },
} satisfies Command

export default copy
