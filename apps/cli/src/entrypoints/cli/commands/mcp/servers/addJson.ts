import type { Command } from '@commander-js/extra-typings'

function loadMcpClient() {
  return import('#core/mcp/client')
}

export function registerMcpServerAddJsonCommand(args: { mcp: Command }): void {
  args.mcp
    .command('add-json <name> <json>')
    .description('Add an MCP server with a JSON string')
    .option(
      '-s, --scope <scope>',
      'Configuration scope (project, global, or mcprc)',
      'project',
    )
    .action(async (name, jsonStr, options) => {
      const mcpClient = await loadMcpClient()
      try {
        const scope = mcpClient.ensureConfigScope(options.scope)

        let serverConfig: any
        try {
          serverConfig = JSON.parse(jsonStr)
        } catch {
          console.error('Error: Invalid JSON string')
          process.exit(1)
        }

        if (
          !serverConfig ||
          typeof serverConfig !== 'object' ||
          !('type' in serverConfig)
        ) {
          console.error('Error: Invalid server configuration format')
          process.exit(1)
        }

        mcpClient.addMcpServer(name, serverConfig, scope)

        switch (serverConfig.type) {
          case 'http':
          case 'sse':
          case 'sse-ide':
          case 'ws':
          case 'ws-ide':
            console.log(
              `Added ${serverConfig.type.toUpperCase()} MCP server ${name} with URL: ${serverConfig.url} to ${scope} config`,
            )
            break
          case 'stdio':
          default:
            console.log(
              `Added stdio MCP server ${name} with command: ${serverConfig.command} ${(serverConfig.args || []).join(' ')} to ${scope} config`,
            )
            break
        }

        process.exit(0)
      } catch (error) {
        console.error((error as Error).message)
        process.exit(1)
      }
    })
}
