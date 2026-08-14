import { describe, expect, it } from 'bun:test'
import { __buildHelpLinesForTests } from './HelpScreen'
import type { Command } from '#cli-commands'
import { getCommandShortcutHints } from '#ui-ink/utils/commandShortcutHints'

describe('HelpScreen helpers', () => {
  it('surfaces both print and headless non-interactive usage', () => {
    const lines = __buildHelpLinesForTests([])
    const usage = lines.find(line => line.startsWith('- Non-interactive:'))

    expect(usage).toContain('-p "question"')
    expect(usage).toContain('--headless "question"')
  })

  it('shows command arguments and slash-prefixed aliases', () => {
    const command = {
      type: 'local',
      name: 'deploy',
      description: 'Deploy the current project',
      argumentHint: '<environment>',
      aliases: ['ship'],
      isEnabled: true,
      isHidden: false,
      userFacingName: () => 'deploy',
      call: async () => '',
    } satisfies Command

    const lines = __buildHelpLinesForTests([command])

    expect(lines).toContain(
      '- /deploy <environment> [Other] — Deploy the current project (aliases: /ship)',
    )
    expect(lines).toContain(
      '- /: Browse common commands; type to narrow, Tab accepts',
    )
  })

  it('surfaces the primary command effects and platform shortcut labels', () => {
    const lines = __buildHelpLinesForTests([])
    const hints = getCommandShortcutHints()

    expect(lines).toContain('Quick commands')
    for (const command of hints.commands) {
      expect(lines).toContain(`- ${command.trigger}: ${command.effect}`)
    }
    for (const shortcut of hints.shortcuts) {
      expect(
        lines.some(line => line.startsWith(`- ${shortcut.trigger}:`)),
      ).toBe(true)
    }
    expect(lines).toContain(
      `- ${hints.shortcuts[0]!.trigger.slice(0, -1)}T: Thinking mode (automatic, enabled, or disabled)`,
    )
  })

  it('describes the transcript shortcut consistently with F6', () => {
    const lines = __buildHelpLinesForTests([])
    expect(lines).toContain('- Ctrl+O: Transcript (scroll/copy)')
    expect(lines.some(line => line.includes('Toggle verbose transcript'))).toBe(
      false,
    )
    // The fictional "Down Arrow opens Tasks" claim is gone.
    expect(
      lines.some(line => line.includes('Down Arrow (empty input): Tasks')),
    ).toBe(false)
  })

  it('lists the full catalog grouped by category with showAll', () => {
    const themeCommand = {
      type: 'local',
      name: 'theme',
      description: 'Switch the color theme',
      isEnabled: true,
      isHidden: false,
      userFacingName: () => 'theme',
      call: async () => '',
    } satisfies Command

    // Default view: with a mixed list containing a primary command, the
    // non-primary "theme" command stays hidden.
    const helpCommand = {
      type: 'local',
      name: 'help',
      description: 'Show help',
      isEnabled: true,
      isHidden: false,
      userFacingName: () => 'help',
      call: async () => '',
    } satisfies Command

    const defaultLines = __buildHelpLinesForTests([helpCommand, themeCommand])
    expect(defaultLines.some(line => line.includes('/theme'))).toBe(false)
    expect(defaultLines.some(line => line.includes('/help'))).toBe(true)

    // /help all shows the whole catalog with category section headers.
    const allLines = __buildHelpLinesForTests([helpCommand, themeCommand], {
      showAll: true,
    })
    expect(
      allLines.some(
        line =>
          line.includes('/theme') && line.includes('Switch the color theme'),
      ),
    ).toBe(true)
    expect(allLines.some(line => line === 'Other commands [Other]')).toBe(true)
  })
})
