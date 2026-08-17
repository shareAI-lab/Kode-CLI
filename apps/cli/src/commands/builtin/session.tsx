import { createCommandGroup } from './commandGroup'

const session = createCommandGroup({
  name: 'session',
  description:
    'Manage the current conversation, its checkpoints, and project memory',
  items: [
    {
      id: 'history',
      commandName: 'transcript',
      label: 'Transcript',
      description: 'Browse and copy the current conversation',
      aliases: ['transcript'],
    },
    {
      id: 'title',
      commandName: 'rename',
      label: 'Title',
      description: 'Set the current session title',
      aliases: ['rename'],
      argumentHint: '<title>',
    },
    {
      id: 'tag',
      commandName: 'tag',
      label: 'Tag',
      description: 'Set a session tag',
      argumentHint: '<tag>',
    },
    {
      id: 'copy',
      commandName: 'copy',
      label: 'Copy',
      description: 'Copy message or transcript text',
    },
    {
      id: 'export',
      commandName: 'export',
      label: 'Export',
      description: 'Export the current conversation',
    },
    {
      id: 'import',
      commandName: 'import',
      label: 'Import',
      description: 'Import a legacy session',
    },
    {
      id: 'checkpoint',
      commandName: 'checkpoint',
      label: 'Checkpoint',
      description: 'Create or list file-level Git checkpoints',
      argumentHint: 'create|list',
    },
    {
      id: 'restore',
      commandName: 'rollback',
      label: 'Restore checkpoint',
      description: 'Restore a file-level Git checkpoint',
      aliases: ['rollback'],
      argumentHint: '<checkpoint-id>',
    },
    {
      id: 'memory',
      commandName: 'memory',
      label: 'Memory',
      description: 'Manage project-scoped long-term memories',
    },
    {
      id: 'learning',
      commandName: 'learning',
      label: 'Learning',
      description: 'Inspect or reject learned workflow hints',
    },
    {
      id: 'note',
      commandName: 'note',
      label: 'Project note',
      description: 'Save a note to AGENTS.md',
      argumentHint: '<text>',
    },
  ],
})

export default session
