import { createCommandGroup } from './commandGroup'

const inspect = createCommandGroup({
  name: 'inspect',
  description:
    'Inspect the current session, workspace, integrations, and CLI health',
  items: [
    {
      id: 'status',
      commandName: 'status',
      label: 'Session status',
      description: 'Show the current session and model status',
    },
    {
      id: 'files',
      commandName: 'files',
      label: 'Context files',
      description: 'List files currently in the conversation context',
    },
    {
      id: 'open',
      commandName: 'open',
      label: 'Project files',
      description: 'Browse project files and open one in $EDITOR',
    },
    {
      id: 'browser',
      commandName: 'browser',
      label: 'Browser safety',
      description: 'Show browser automation safety status',
    },
    {
      id: 'cost',
      commandName: 'cost',
      label: 'Session cost',
      description: 'Show the session cost and duration',
    },
    {
      id: 'doctor',
      commandName: 'doctor',
      label: 'CLI health',
      description: 'Run installation and environment diagnostics',
    },
    {
      id: 'console',
      commandName: 'console',
      label: 'TUI console',
      description: 'View captured stdout and stderr writes',
    },
    {
      id: 'pr',
      commandName: 'pr-comments',
      label: 'Pull request comments',
      description: 'Fetch GitHub pull request comments',
      aliases: ['pr-comments'],
    },
    {
      id: 'feedback',
      commandName: 'bug',
      label: 'Feedback',
      description: 'Submit product feedback or a bug report',
      aliases: ['bug'],
    },
  ],
})

export default inspect
