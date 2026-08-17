import type { Command } from '../types'
import { PRODUCT_NAME } from '#core/constants/product'

function makeStubCommand(args: {
  name: string
  description: string
  aliases?: string[]
  isHidden?: boolean
  message?: string
}): Command {
  const message =
    args.message ??
    `/${args.name} is not supported in ${PRODUCT_NAME} yet.\n` +
      `This command exists for compatibility.\n` +
      `Try /help for supported commands.`

  return {
    type: 'local',
    name: args.name,
    description: args.description,
    aliases: args.aliases,
    isEnabled: true,
    isHidden: args.isHidden ?? false,
    disableNonInteractive: true,
    async call() {
      return message
    },
    userFacingName() {
      return args.name
    },
  }
}

export const PARITY_STUB_COMMANDS: Command[] = [
  makeStubCommand({
    name: 'btw',
    description:
      'Ask a quick side question without interrupting the main conversation',
    isHidden: true,
  }),
  makeStubCommand({
    name: 'chrome',
    description: 'Browser integration settings',
    isHidden: true,
  }),
  makeStubCommand({
    name: 'color',
    description: 'Change the color theme',
    isHidden: true,
    message: `Use /theme to change the color theme.`,
  }),
  makeStubCommand({
    name: 'discover',
    description: 'Explore features and track your progress',
    isHidden: true,
  }),
  makeStubCommand({
    name: 'extra-usage',
    description: 'Configure extra usage when limits are hit',
    isHidden: true,
  }),
  makeStubCommand({
    name: 'fork',
    description: 'Fork the current conversation',
    isHidden: true,
  }),
  makeStubCommand({
    name: 'ide',
    description: 'Connect to an IDE for integrated development features',
    message: `Use /lsp for editor integration in ${PRODUCT_NAME}.`,
  }),
  makeStubCommand({
    name: 'install',
    description: 'Install the CLI runtime',
    isHidden: true,
  }),
  makeStubCommand({
    name: 'install-github-app',
    description: 'Install GitHub App integration',
    isHidden: true,
  }),
  makeStubCommand({
    name: 'install-slack-app',
    description: 'Install Slack App integration',
    isHidden: true,
  }),
  makeStubCommand({
    name: 'keybindings',
    description: 'Open or create your keybindings configuration file',
    isHidden: true,
  }),
  makeStubCommand({
    name: 'memory',
    description: 'Manage memory files',
    isHidden: true,
  }),
  makeStubCommand({
    name: 'mobile',
    description: 'Show mobile app download instructions',
    isHidden: true,
  }),
  makeStubCommand({
    name: 'passes',
    description: 'Manage authentication / passes',
    isHidden: true,
  }),
  makeStubCommand({
    name: 'privacy-settings',
    description: 'Privacy settings',
    isHidden: true,
  }),
  makeStubCommand({
    name: 'rate-limit-options',
    description: 'Rate limit options',
    isHidden: true,
  }),
  makeStubCommand({
    name: 'remote-env',
    description: 'Configure the default remote environment',
    isHidden: true,
  }),
  makeStubCommand({
    name: 'stats',
    description: 'Usage statistics and activity',
    isHidden: true,
  }),
  makeStubCommand({
    name: 'stickers',
    description: 'Order stickers',
    isHidden: true,
  }),
  makeStubCommand({
    name: 'think-back',
    description: 'Year in review',
    isHidden: true,
  }),
  makeStubCommand({
    name: 'thinkback-play',
    description: 'Play the thinkback animation',
    isHidden: true,
  }),
  makeStubCommand({
    name: 'upgrade',
    description: 'Upgrade plan / subscription',
    isHidden: true,
  }),
  makeStubCommand({
    name: 'usage',
    description: 'Show plan usage limits',
    isHidden: true,
  }),
]
