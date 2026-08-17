import type { Command } from '../types'
import { getMessagesGetter } from '#core/messages'
import { copyTextToClipboard } from '#cli-utils/clipboard'
import { buildTranscriptLines } from '#cli-utils/transcriptText'
import { writeFile } from 'fs/promises'
import { resolve } from 'path'

function normalizeExportFilename(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  if (trimmed.endsWith('.txt')) return trimmed
  if (trimmed.includes('.')) return trimmed.replace(/\.[^.]+$/, '.txt')
  return `${trimmed}.txt`
}

function defaultExportFilename(): string {
  const iso = new Date().toISOString().replace(/[:.]/g, '-')
  return `conversation-${iso}.txt`
}

function buildExportText(): string {
  const messages = getMessagesGetter()()
  return buildTranscriptLines(messages, {
    includeTools: true,
    collapseToolBlocks: true,
    maxCollapsedChars: 4000,
  }).join('\n')
}

const exportCommand = {
  type: 'local',
  name: 'export',
  description: 'Export the current conversation to a file or clipboard',
  argumentHint: '[filename]',
  isEnabled: true,
  isHidden: true,
  async call(args: string) {
    const content = buildExportText()
    const filename = normalizeExportFilename(args || '')

    if (filename) {
      const abs = resolve(process.cwd(), filename)
      await writeFile(abs, content, 'utf-8')
      return `Conversation exported to: ${filename}`
    }

    try {
      await copyTextToClipboard(content)
      return `Conversation exported to clipboard. Use /export ${defaultExportFilename()} to save to a file.`
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return `Failed to export to clipboard: ${message}\nTip: Use /export ${defaultExportFilename()} to save to a file.`
    }
  },
  userFacingName() {
    return 'export'
  },
} satisfies Command

export default exportCommand
