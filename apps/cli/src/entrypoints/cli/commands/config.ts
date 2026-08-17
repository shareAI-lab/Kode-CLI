import { cwd } from 'process'
import type { Command } from '@commander-js/extra-typings'

import { PRODUCT_COMMAND } from '#core/constants/product'
import { setup } from '../setup'

export function registerConfigCommands(program: Command): void {
  // Config
  const config = program
    .command('config')
    .description(
      `Manage configuration (eg. ${PRODUCT_COMMAND} config set -g theme dark)`,
    )

  config
    .command('get <key>')
    .description('Get a config value')
    .option('--cwd <cwd>', 'The current working directory', String, cwd())
    .option('-g, --global', 'Use global config')
    .action(async (key, { cwd, global }) => {
      await setup(cwd, false)
      const { getConfigForCLI } = await import('#config')
      console.log(getConfigForCLI(key, global ?? false))
      process.exit(0)
    })

  config
    .command('set <key> <value>')
    .description('Set a config value')
    .option('--cwd <cwd>', 'The current working directory', String, cwd())
    .option('-g, --global', 'Use global config')
    .action(async (key, value, { cwd, global }) => {
      await setup(cwd, false)
      const { setConfigForCLI } = await import('#config')
      setConfigForCLI(key, value, global ?? false)
      console.log(`Set ${key} to ${value}`)
      process.exit(0)
    })

  config
    .command('remove <key>')
    .description('Remove a config value')
    .option('--cwd <cwd>', 'The current working directory', String, cwd())
    .option('-g, --global', 'Use global config')
    .action(async (key, { cwd, global }) => {
      await setup(cwd, false)
      const { deleteConfigForCLI } = await import('#config')
      deleteConfigForCLI(key, global ?? false)
      console.log(`Removed ${key}`)
      process.exit(0)
    })

  config
    .command('list')
    .description('List all config values')
    .option('--cwd <cwd>', 'The current working directory', String, cwd())
    .option('-g, --global', 'Use global config', false)
    .action(async ({ cwd, global }) => {
      await setup(cwd, false)
      const { listConfigForCLI } = await import('#config')
      console.log(
        JSON.stringify(
          global ? listConfigForCLI(true) : listConfigForCLI(false),
          null,
          2,
        ),
      )
      process.exit(0)
    })
}
