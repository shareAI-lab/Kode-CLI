import { describe, expect, test } from 'bun:test'

import { createCliProgram } from '#host-cli/entrypoints/cli/cliParser'

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function getCommandHelp(commandPath: string[]): string {
  const program = createCliProgram('', undefined)
  let command: (typeof program.commands)[number] = program
  for (const name of commandPath) {
    const child = command.commands.find(item => item.name() === name)
    expect(child).toBeTruthy()
    command = child!
  }
  return command.helpInformation().replace(/\r\n/g, '\n')
}

function findCommandLineIndex(help: string, command: string): number {
  const re = new RegExp(`(?:^|\\n)\\s{2}${escapeRegExp(command)}(?=\\s)`, 'm')
  const match = re.exec(help)
  expect(match).toBeTruthy()
  return match?.index ?? -1
}

describe('cli mcp help', () => {
  test('`kode mcp --help` contains expected commands in order', () => {
    const out = getCommandHelp(['mcp'])

    expect(out).toContain('Usage: kode mcp')
    expect(out).toContain('Configure and manage MCP servers')

    const expectedCommands = [
      'serve',
      'add-sse',
      'add-http',
      'add-ws',
      'add',
      'remove',
      'list',
      'add-json',
      'get',
      'add-from-claude-desktop',
      'reset-project-choices',
      'reset-mcprc-choices',
    ]

    let lastIndex = -1
    for (const command of expectedCommands) {
      const index = findCommandLineIndex(out, command)
      expect(index).toBeGreaterThan(lastIndex)
      lastIndex = index
    }
  })

  test('`kode mcp add --help` exposes key flags', () => {
    const out = getCommandHelp(['mcp', 'add'])

    expect(out).toContain('Usage: kode mcp add')
    expect(out).toContain('--scope')
    expect(out).toContain('--transport')
    expect(out).toContain('--header')
    expect(out).toContain('--env')
  })
})
