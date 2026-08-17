import React from 'react'

import type { Command } from '../types'
import {
  CommandGroupRedirect,
  CommandGroupScreen,
  type CommandGroupItem,
} from '#ui-ink/screens/overlays/CommandGroupScreen'

export type CommandGroupDefinition = {
  name: string
  description: string
  items: readonly CommandGroupItem[]
}

export type CommandGroupTarget = {
  commandName: string
  args: string
}

export function resolveCommandGroupTarget(
  input: string,
  items: readonly CommandGroupItem[],
): CommandGroupTarget | null {
  const trimmedInput = input.trim()
  const [rawId = ''] = trimmedInput.split(/\s+/u)
  if (!rawId) return null

  const id = rawId.toLowerCase()
  const item = items.find(
    candidate =>
      candidate.id.toLowerCase() === id ||
      candidate.aliases?.some(alias => alias.toLowerCase() === id),
  )
  if (!item) return null

  return {
    commandName: item.commandName,
    args: trimmedInput.slice(rawId.length).trimStart(),
  }
}

export function createCommandGroup(
  definition: CommandGroupDefinition,
): Command {
  const { name, description, items } = definition
  return {
    type: 'local-jsx',
    name,
    description,
    argumentHint: '[subcommand] …',
    isEnabled: true,
    isHidden: false,
    disableNonInteractive: true,
    ui: { displayMode: 'fullscreen' },
    async call(onDone, _context, args = '') {
      const target = resolveCommandGroupTarget(args, items)
      if (target) {
        return (
          <CommandGroupRedirect
            commandName={target.commandName}
            args={target.args}
            onDone={onDone}
          />
        )
      }

      return (
        <CommandGroupScreen
          title={`/${name}`}
          description={description}
          items={items}
          initialQuery={args.trim()}
          onDone={onDone}
        />
      )
    },
    userFacingName() {
      return name
    },
  }
}
