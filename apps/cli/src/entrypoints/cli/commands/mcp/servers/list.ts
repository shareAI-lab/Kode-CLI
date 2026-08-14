import type { Command } from '@commander-js/extra-typings'

import { PRODUCT_COMMAND } from '#core/constants/product'

function loadMcpClient() {
  return import('#core/mcp/client')
}

export function registerMcpServerListCommand(args: { mcp: Command }): void {
  args.mcp
    .command('list')
    .description('List configured MCP servers')
    .action(async () => {
      const mcpClient = await loadMcpClient()
      const { getProjectMcpServerDefinitions } = await import('#config')
      try {
        const servers = mcpClient.listMCPServers()
        if (Object.keys(servers).length === 0) {
          console.log(
            `No MCP servers configured. Use \`${PRODUCT_COMMAND} mcp add\` to add a server.`,
          )
          process.exit(0)
        }

        const projectFileServers = getProjectMcpServerDefinitions()
        const clients = await mcpClient.getClients()
        const clientByName = new Map<string, (typeof clients)[number]>()
        for (const client of clients) {
          clientByName.set(client.name, client)
        }

        const names = Object.keys(servers).sort((a, b) => a.localeCompare(b))
        for (const name of names) {
          const server = servers[name]!

          const client = clientByName.get(name)
          const status =
            client?.type === 'connected'
              ? 'connected'
              : client?.type === 'failed'
                ? 'failed'
                : projectFileServers.servers[name]
                  ? (() => {
                      const approval = mcpClient.getMcprcServerStatus(name)
                      if (approval === 'pending') return 'pending'
                      if (approval === 'rejected') return 'rejected'
                      return 'disconnected'
                    })()
                  : 'disconnected'

          const summary = (() => {
            switch (server.type) {
              case 'http':
                return `${server.url} (http)`
              case 'sse':
                return `${server.url} (sse)`
              case 'sse-ide':
                return `${server.url} (sse-ide)`
              case 'ws':
                return `${server.url} (ws)`
              case 'ws-ide':
                return `${server.url} (ws-ide)`
              case 'stdio':
              default:
                return `${server.command} ${(server.args || []).join(' ')} (stdio)`
            }
          })()

          console.log(`${name}: ${summary} [${status}]`)
        }

        process.exit(0)
      } catch (error) {
        console.error((error as Error).message)
        process.exit(1)
      }
    })
}
