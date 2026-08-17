import { describe, expect, test } from 'bun:test'

import { filterCommandGroupItems } from '#ui-ink/screens/overlays/CommandGroupScreen'
import { resolveCommandGroupTarget } from './commandGroup'

const items = [
  {
    id: 'history',
    commandName: 'transcript',
    label: 'Transcript',
    description: 'Browse the current conversation',
    aliases: ['transcript'],
  },
  {
    id: 'restore',
    commandName: 'rollback',
    label: 'Restore checkpoint',
    description: 'Restore a checkpoint',
    aliases: ['rollback'],
  },
] as const

describe('aggregate command routing', () => {
  test('routes a canonical subcommand and preserves its arguments', () => {
    expect(
      resolveCommandGroupTarget('restore checkpoint-42 --force', items),
    ).toEqual({
      commandName: 'rollback',
      args: 'checkpoint-42 --force',
    })
  })

  test('preserves spacing inside the delegated arguments', () => {
    expect(
      resolveCommandGroupTarget('restore checkpoint-42  --force', items),
    ).toEqual({
      commandName: 'rollback',
      args: 'checkpoint-42  --force',
    })
  })

  test('routes an alias without changing the target command', () => {
    expect(resolveCommandGroupTarget('transcript', items)).toEqual({
      commandName: 'transcript',
      args: '',
    })
  })

  test('does not route an empty or unknown subcommand', () => {
    expect(resolveCommandGroupTarget('', items)).toBeNull()
    expect(resolveCommandGroupTarget('missing item', items)).toBeNull()
  })

  test('filters by command name, alias, label, and description', () => {
    expect(filterCommandGroupItems(items, 'history')).toEqual([items[0]])
    expect(filterCommandGroupItems(items, 'rollback')).toEqual([items[1]])
    expect(filterCommandGroupItems(items, 'checkpoint')).toEqual([items[1]])
    expect(filterCommandGroupItems(items, 'restore checkpoint')).toEqual([
      items[1],
    ])
  })
})
