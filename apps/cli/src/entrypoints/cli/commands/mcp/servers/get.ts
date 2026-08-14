import type { Command } from '@commander-js/extra-typings'

function loadMcpClient() {
  return import('#core/mcp/client')
}

function scopeDisplayForCli(scope: string): string {
  switch (scope) {
    case 'project':
      return 'local'
    case 'global':
      return 'user'
    case 'mcpjson':
      return 'project'
    case 'mcprc':
      return 'mcprc'
    default:
      return scope
  }
}

export function registerMcpServerGetCommand(args: { mcp: Command }): void {
  args.mcp
    .command('get <name>')
    .description('Get details about an MCP server')
    .action(async (name: string) => {
      const mcpClient = await loadMcpClient()
      try {
        const server = mcpClient.getMcpServer(name)
        if (!server) {
          console.error(`No MCP server found with name: ${name}`)
          process.exit(1)
        }

        const { getProjectMcpServerDefinitions } = await import('#config')
        const projectFileServers = getProjectMcpServerDefinitions()
        const clients = await mcpClient.getClients()
        const client = clients.find(c => c.name === name)

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

        const scopeDisplay = scopeDisplayForCli(server.scope)

        console.log(`${name}:`)
        console.log(`  Status: ${status}`)
        console.log(`  Scope: ${scopeDisplay}`)

        const printHeaders = (headers: Record<string, string> | undefined) => {
          if (!headers || Object.keys(headers).length === 0) return
          console.log('  Headers:')
          for (const [key, value] of Object.entries(headers)) {
            console.log(`    ${key}: ${value}`)
          }
        }

        switch (server.type) {
          case 'http':
            console.log(`  Type: http`)
            console.log(`  URL: ${server.url}`)
            printHeaders(server.headers)
            break
          case 'sse':
            console.log(`  Type: sse`)
            console.log(`  URL: ${server.url}`)
            printHeaders(server.headers)
            break
          case 'sse-ide':
            console.log(`  Type: sse-ide`)
            console.log(`  URL: ${server.url}`)
            console.log(`  IDE: ${server.ideName}`)
            printHeaders(server.headers)
            break
          case 'ws':
            console.log(`  Type: ws`)
            console.log(`  URL: ${server.url}`)
            break
          case 'ws-ide':
            console.log(`  Type: ws-ide`)
            console.log(`  URL: ${server.url}`)
            console.log(`  IDE: ${server.ideName}`)
            break
          case 'stdio':
          default:
            console.log(`  Type: stdio`)
            console.log(`  Command: ${server.command}`)
            console.log(`  Args: ${(server.args || []).join(' ')}`)
            if (server.env) {
              console.log('  Environment:')
              for (const [key, value] of Object.entries(server.env)) {
                console.log(`    ${key}=${value}`)
              }
            }
            break
        }
        process.exit(0)
      } catch (error) {
        console.error((error as Error).message)
        process.exit(1)
      }
    })
}
