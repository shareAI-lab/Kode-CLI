import { describe, expect, test } from 'bun:test'

import { createCliProgram } from '#host-cli/entrypoints/cli/cliParser'
import { exitOverrideRecursive } from '../helpers/cliExitOverride'

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function runHelp(argv: string[]): string {
  const program = createCliProgram('', undefined)
  let out = ''

  program.configureOutput({
    writeOut: str => {
      out += str
    },
    writeErr: str => {
      out += str
    },
  })

  exitOverrideRecursive(program)
  try {
    program.parse(argv, { from: 'user' })
    throw new Error('expected commander to exit')
  } catch (err: any) {
    expect(err.code).toBe('commander.helpDisplayed')
    expect(err.exitCode).toBe(0)
  }

  return out.replace(/\r\n/g, '\n')
}

function findCommandLineIndex(help: string, command: string): number {
  const re = new RegExp(`(?:^|\\n)\\s{2}${escapeRegExp(command)}(?=\\s)`, 'm')
  const match = re.exec(help)
  expect(match).toBeTruthy()
  return match?.index ?? -1
}

describe('cli context help', () => {
  test('`kode context --help` contains expected commands in order', () => {
    const out = runHelp(['context', '--help'])

    expect(out).toContain('Usage: kode context')
    expect(out).toContain('Set static context')
    expect(out).toContain('context add-file')

    const expectedCommands = ['get', 'set', 'list', 'remove']

    let lastIndex = -1
    for (const command of expectedCommands) {
      const index = findCommandLineIndex(out, command)
      expect(index).toBeGreaterThan(lastIndex)
      lastIndex = index
    }
  })

  test('`kode context set --help` exposes --cwd', () => {
    const out = runHelp(['context', 'set', '--help'])

    expect(out).toContain('Usage: kode context set')
    expect(out).toContain('Set a value in context')
    expect(out).toContain('--cwd <cwd>')
  })
})
