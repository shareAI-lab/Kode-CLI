import { describe, expect, test } from 'bun:test'

import { __appForTests } from './App'

describe('App terminal chrome', () => {
  test('keeps the default web navigation to implemented views', () => {
    expect(__appForTests.terminalViews).toEqual([
      { value: 'chat', label: 'Chat' },
      { value: 'schedules', label: 'Schedules' },
      { value: 'settings', label: 'Settings' },
    ])
  })

  test('summarizes runtime state in the compact status dot', () => {
    expect(
      __appForTests.runtimeStatusDotLabel({
        runtimeAttached: true,
        runtimeStatus: 'daemon online',
        running: true,
      }),
    ).toBe('daemon online | runtime attached | agent running')

    expect(
      __appForTests.runtimeStatusDotLabel({
        runtimeAttached: false,
        runtimeStatus: 'daemon checking',
        running: false,
      }),
    ).toBe('daemon checking | runtime detached | agent idle')
  })
})
