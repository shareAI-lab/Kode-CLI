import type { Command } from '../types'
import * as React from 'react'
import { WorkTasksScreen } from '#ui-ink/screens/overlays/WorkTasksScreen'
import { createCommandGroup } from './commandGroup'

export const workBoard = {
  type: 'local-jsx',
  name: 'work-board',
  description: 'Show current work tasks',
  isEnabled: true,
  isHidden: true,
  aliases: ['todos', 'tasklist'],
  ui: { displayMode: 'fullscreen' },
  async call(onDone) {
    return <WorkTasksScreen onDone={onDone} />
  },
  userFacingName() {
    return 'work-board'
  },
} satisfies Command

const work = createCommandGroup({
  name: 'work',
  description: 'Plan, monitor, schedule, and recover local work',
  items: [
    {
      id: 'board',
      commandName: 'work-board',
      label: 'Work board',
      description: 'Show the current work task board',
      aliases: ['todos', 'tasklist'],
    },
    {
      id: 'plan',
      commandName: 'plan',
      label: 'Plan mode',
      description: 'Enable plan mode or open the current plan',
    },
    {
      id: 'goal',
      commandName: 'goal',
      label: 'Goals',
      description: 'Manage durable session goals',
      aliases: ['goals'],
    },
    {
      id: 'schedule',
      commandName: 'loop',
      label: 'Scheduled work',
      description: 'Manage fixed-interval goal prompts',
      aliases: ['loop'],
    },
    {
      id: 'tasks',
      commandName: 'tasks',
      label: 'Background tasks',
      description: 'Inspect agents and shell tasks',
    },
    {
      id: 'runs',
      commandName: 'runs',
      label: 'Durable runs',
      description: 'Inspect local durable-run records',
    },
    {
      id: 'automation',
      commandName: 'automation',
      label: 'Automation recovery',
      description: 'Recover interrupted goal runs',
    },
    {
      id: 'supervisor',
      commandName: 'supervisor',
      label: 'Task supervisor',
      description: 'Plan and inspect dependency-aware task runs',
    },
    {
      id: 'worktree',
      commandName: 'worktree',
      label: 'Worktrees',
      description: 'Manage agent worktrees',
      aliases: ['tree'],
    },
    {
      id: 'watch',
      commandName: 'watch',
      label: 'GitHub watch',
      description: 'Run read-only PR or workflow probes',
    },
  ],
})

export default work
export function WorkTasksViewForTests({ onClose }: { onClose: () => void }) {
  return <WorkTasksScreen onDone={onClose} />
}
