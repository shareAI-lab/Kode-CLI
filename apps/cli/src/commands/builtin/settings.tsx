import { createCommandGroup } from './commandGroup'

const settings = createCommandGroup({
  name: 'settings',
  description: 'Configure Kode, appearance, terminal behavior, and safeguards',
  items: [
    {
      id: 'general',
      commandName: 'config',
      label: 'General configuration',
      description: 'Open the configuration panel',
      aliases: ['config'],
    },
    {
      id: 'model',
      commandName: 'model',
      label: 'Model',
      description: 'Choose a provider and model for this session',
    },
    {
      id: 'permissions',
      commandName: 'permissions',
      label: 'Permissions',
      description: 'Manage allow and deny rules for tools',
    },
    {
      id: 'sandbox',
      commandName: 'sandbox',
      label: 'Sandbox',
      description: 'Configure sandbox boundaries',
    },
    {
      id: 'appearance',
      commandName: 'theme',
      label: 'Appearance',
      description: 'Change the theme and color treatment',
      aliases: ['theme', 'color'],
    },
    {
      id: 'output',
      commandName: 'output-style',
      label: 'Output style',
      description: 'Set response formatting preferences',
      aliases: ['output-style'],
    },
    {
      id: 'editor',
      commandName: 'vim',
      label: 'Editor mode',
      description: 'Switch between Vim and normal input modes',
      aliases: ['vim'],
    },
    {
      id: 'terminal',
      commandName: 'terminal-setup',
      label: 'Terminal setup',
      description: 'Configure multi-line terminal input',
      aliases: ['terminal-setup'],
    },
    {
      id: 'statusline',
      commandName: 'statusline',
      label: 'Status line',
      description: 'Set up the terminal status line',
    },
    {
      id: 'notifications',
      commandName: 'notifications',
      label: 'Notifications',
      description: 'View in-app notification history',
    },
  ],
})

export default settings
