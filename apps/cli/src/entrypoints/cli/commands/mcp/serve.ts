import { existsSync } from 'node:fs'
import { cwd } from 'process'
import type { Command } from '@commander-js/extra-typings'

import { PRODUCT_NAME } from '#core/constants/product'

import { setup } from '../../setup'

export function registerMcpServeCommand(args: {
  program: Command
  mcp: Command
}): void {
  args.mcp
    .command('serve')
    .description(`Start the ${PRODUCT_NAME} MCP server`)
    .action(async () => {
      const providedCwd = (args.program.opts() as { cwd?: string }).cwd ?? cwd()

      if (!existsSync(providedCwd)) {
        console.error(`Error: Directory ${providedCwd} does not exist`)
        process.exit(1)
      }

      try {
        await setup(providedCwd, false)
        const [{ startMCPServer }, { getAllTools }] = await Promise.all([
          import('#host-mcp'),
          import('#tools'),
        ])
        await startMCPServer(providedCwd, getAllTools())
      } catch (error) {
        console.error('Error: Failed to start MCP server:', error)
        process.exit(1)
      }
    })
}
