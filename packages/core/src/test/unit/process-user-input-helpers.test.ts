import { describe, expect, test } from 'bun:test'
import {
  collectCommandNames,
  formatUnknownSlashCommandMessage,
  levenshteinDistance,
  suggestUnknownSlashCommands,
} from '#ui-ink/utils/processUserInputHelpers'

describe('unknown slash command helpers', () => {
  test('ranks prefix and one-edit typos ahead of unrelated names', () => {
    const names = collectCommandNames([
      { userFacingName: () => 'help', aliases: ['h'] },
      { userFacingName: () => 'model' },
      { userFacingName: () => 'mcp' },
    ])

    expect(names).toEqual(['help', 'h', 'model', 'mcp'])
    expect(suggestUnknownSlashCommands('hepl', names)).toEqual(['help'])
    expect(suggestUnknownSlashCommands('mo', names)).toEqual(['model'])
    expect(levenshteinDistance('hepl', 'help')).toBe(2)
  })

  test('formats a local unknown-command message with suggestions', () => {
    const message = formatUnknownSlashCommandMessage('hepl', ['help', 'model'])
    expect(message).toContain('Unknown command: /hepl')
    expect(message).toContain('/help')
    expect(message).toContain('//')
  })
})
