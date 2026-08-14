import { describe, expect, test } from 'bun:test'
import { Command } from '@commander-js/extra-typings'

import { registerVoiceCommands } from './voice'

describe('kode voice', () => {
  test('does not expose a stop command that cannot reach another TUI process', () => {
    const program = new Command()
    registerVoiceCommands(program)

    const voice = program.commands.find(command => command.name() === 'voice')
    expect(voice?.commands.map(command => command.name())).toEqual(['status'])
  })
})
