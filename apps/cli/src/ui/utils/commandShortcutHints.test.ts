import { describe, expect, test } from 'bun:test'
import {
  getCommandShortcutHints,
  getShortcutModifierLabel,
} from './commandShortcutHints'

describe('command shortcut hints', () => {
  test('uses platform-accurate Option and Alt labels', () => {
    expect(getShortcutModifierLabel('darwin')).toBe('Option')
    expect(getShortcutModifierLabel('win32')).toBe('Alt')
  })

  test('describes the primary commands and shortcuts by their effect', () => {
    const hints = getCommandShortcutHints('win32')

    expect(hints.commands).toEqual([
      { trigger: '/config', effect: 'setup models and tools' },
      { trigger: '/help', effect: 'open help' },
      { trigger: '/model', effect: 'manage models' },
      { trigger: '/init', effect: 'create AGENTS.md' },
    ])
    expect(hints.shortcuts).toEqual([
      { trigger: 'Alt+M', effect: 'switch model' },
      { trigger: 'Alt+G', effect: 'open external editor' },
    ])
  })
})
