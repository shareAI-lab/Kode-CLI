import { createCommandGroup } from './commandGroup'

const extensions = createCommandGroup({
  name: 'extensions',
  description:
    'Manage plugins, skills, MCP servers, hooks, and agent configuration',
  items: [
    {
      id: 'plugins',
      commandName: 'plugins',
      label: 'Plugins',
      description: 'Browse and manage installed plugins',
    },
    {
      id: 'marketplace',
      commandName: 'plugin',
      label: 'Plugin marketplace',
      description: 'Install, enable, disable, or validate plugins',
      aliases: ['plugin'],
      argumentHint: '<command>',
    },
    {
      id: 'skills',
      commandName: 'skills',
      label: 'Skills',
      description: 'List available skills',
    },
    {
      id: 'mcp',
      commandName: 'mcp',
      label: 'MCP servers',
      description: 'Manage Model Context Protocol servers',
    },
    {
      id: 'hooks',
      commandName: 'hooks',
      label: 'Hooks',
      description: 'Configure tool-event hooks',
    },
    {
      id: 'agents',
      commandName: 'agents',
      label: 'Agents',
      description: 'Manage agent configurations',
    },
    {
      id: 'reload',
      commandName: 'refresh-commands',
      label: 'Reload',
      description: 'Reload custom commands and skills from disk',
      aliases: ['refresh-commands'],
    },
  ],
})

export default extensions
