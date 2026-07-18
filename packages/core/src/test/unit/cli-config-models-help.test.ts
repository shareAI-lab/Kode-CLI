import { describe, expect, test } from 'bun:test'

import { createCliProgram } from '#host-cli/entrypoints/cli/cliParser'

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function getCommandHelp(commandName: string): string {
  const program = createCliProgram('', undefined)
  const command = program.commands.find(item => item.name() === commandName)
  expect(command).toBeTruthy()
  return command!.helpInformation().replace(/\r\n/g, '\n')
}

function findCommandLineIndex(help: string, command: string): number {
  const re = new RegExp(`(?:^|\\n)\\s{2}${escapeRegExp(command)}(?=\\s)`, 'm')
  const match = re.exec(help)
  expect(match).toBeTruthy()
  return match?.index ?? -1
}

describe('cli config/models help', () => {
  test('`kode config --help` contains expected commands in order', () => {
    const out = getCommandHelp('config')

    expect(out).toContain('Usage: kode config')
    expect(out).toContain('Manage configuration')

    const expectedCommands = ['get', 'set', 'remove', 'list']
    let lastIndex = -1
    for (const command of expectedCommands) {
      const index = findCommandLineIndex(out, command)
      expect(index).toBeGreaterThan(lastIndex)
      lastIndex = index
    }
  })

  test('`kode models --help` contains expected commands in order', () => {
    const out = getCommandHelp('models')

    expect(out).toContain('Usage: kode models')
    expect(out).toContain('Import/export model profiles and pointers (YAML)')

    const expectedCommands = ['export', 'import', 'list']
    let lastIndex = -1
    for (const command of expectedCommands) {
      const index = findCommandLineIndex(out, command)
      expect(index).toBeGreaterThan(lastIndex)
      lastIndex = index
    }
  })
})
