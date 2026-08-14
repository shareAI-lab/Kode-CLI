import type { Command } from '@commander-js/extra-typings'

import {
  getCurrentProjectConfig,
  getGlobalConfig,
  getProjectMcpServerDefinitions,
} from '#config'
import { PRODUCT_COMMAND } from '#core/constants/product'
import { normalizeMcpScopeForCli } from '@kode/mcp/cliUtils'
function loadMcpClient() {
  return import('#core/mcp/client')
}

export function registerMcpServerRemoveCommand(args: { mcp: Command }): void {
  args.mcp
    .command('remove <name>')
    .description('Remove an MCP server')
    .option(
      '-s, --scope <scope>',
      'Configuration scope (local, user, or project)',
    )
    .action(async (name: string, options: { scope?: string }) => {
      const mcpClient = await loadMcpClient()
      try {
        if (options.scope) {
          const scopeInfo = normalizeMcpScopeForCli(options.scope)
          mcpClient.removeMcpServer(name, scopeInfo.scope)
          console.log(
            `Removed MCP server ${name} from ${scopeInfo.display} config`,
          )
          process.exit(0)
        }

        const matches: Array<{
          scope: ReturnType<typeof mcpClient.ensureConfigScope>
          display: string
        }> = []

        const projectConfig = getCurrentProjectConfig()
        if (projectConfig.mcpServers?.[name]) {
          matches.push({
            scope: mcpClient.ensureConfigScope('project'),
            display: 'local',
          })
        }

        const globalConfig = getGlobalConfig()
        if (globalConfig.mcpServers?.[name]) {
          matches.push({
            scope: mcpClient.ensureConfigScope('global'),
            display: 'user',
          })
        }

        const projectFileDefinitions = getProjectMcpServerDefinitions()
        if (projectFileDefinitions.servers[name]) {
          const source = projectFileDefinitions.sources[name]
          if (source === '.mcp.json') {
            matches.push({
              scope: mcpClient.ensureConfigScope('mcpjson'),
              display: 'project',
            })
          } else {
            matches.push({
              scope: mcpClient.ensureConfigScope('mcprc'),
              display: 'mcprc',
            })
          }
        }

        if (matches.length === 0) {
          throw new Error(`No MCP server found with name: ${name}`)
        }

        if (matches.length > 1) {
          console.error(
            `MCP server "${name}" exists in multiple scopes: ${matches.map(m => m.display).join(', ')}`,
          )
          console.error('Please specify which scope to remove from:')
          for (const match of matches) {
            console.error(
              `  ${PRODUCT_COMMAND} mcp remove ${name} --scope ${match.display}`,
            )
          }
          process.exit(1)
        }

        const match = matches[0]!
        mcpClient.removeMcpServer(name, match.scope)
        console.log(`Removed MCP server ${name} from ${match.display} config`)
        process.exit(0)
      } catch (error) {
        console.error((error as Error).message)
        process.exit(1)
      }
    })
}
