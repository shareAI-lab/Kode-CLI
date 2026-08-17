import { describe, expect, test } from 'bun:test'
import { __buildShortcutRowsForTests } from './ShortcutsScreen'

describe('ShortcutsScreen rows', () => {
  test('keeps setup commands and stash/palette keys discoverable', () => {
    const rows = __buildShortcutRowsForTests({ platform: 'linux' })

    expect(rows.commandRows.map(row => row.label)).toEqual([
      '/config',
      '/help',
      '/model',
      '/init',
      '@path',
    ])
    expect(rows.inputRows.some(row => row.label === 'Ctrl+S')).toBe(true)
    expect(rows.systemRows.some(row => row.label === 'F7')).toBe(true)
    expect(rows.systemRows.some(row => row.label === 'F1')).toBe(true)
    expect(rows.narrowRows.map(row => row.label)).toContain('F7')
    expect(rows.narrowRows.map(row => row.label)).toContain('Ctrl+S')
    expect(rows.inputRows.some(row => row.label === '/bash <cmd>')).toBe(true)
    expect(rows.inputRows.some(row => row.label.startsWith('!'))).toBe(false)
  })
})
