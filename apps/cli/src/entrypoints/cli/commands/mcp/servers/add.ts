import type { Command } from '@commander-js/extra-typings'

import { PRODUCT_COMMAND } from '#core/constants/product'
import {
  looksLikeMcpUrl,
  normalizeMcpScopeForCli,
  normalizeMcpTransport,
  parseMcpHeaders,
} from '@kode/mcp/cliUtils'
function loadMcpClient() {
  return import('#core/mcp/client')
}

export function registerMcpServerAddCommands(args: {
  mcp: Command
  program: Command
}): void {
  args.mcp
    .command('add-sse <name> <url>')
    .description('Add an SSE server')
    .option(
      '-s, --scope <scope>',
      'Configuration scope (local, user, or project)',
      'local',
    )
    .option(
      '-H, --header <header...>',
      'Set headers (e.g. -H "X-Api-Key: abc123" -H "X-Custom: value")',
    )
    .action(async (name, url, options) => {
      const mcpClient = await loadMcpClient()
      try {
        const scopeInfo = normalizeMcpScopeForCli(options.scope)
        const headers = parseMcpHeaders(options.header)

        mcpClient.addMcpServer(
          name,
          { type: 'sse', url, ...(headers ? { headers } : {}) },
          scopeInfo.scope,
        )
        console.log(
          `Added SSE MCP server ${name} with URL: ${url} to ${scopeInfo.display} config`,
        )
        if (headers) {
          console.log(`Headers: ${JSON.stringify(headers, null, 2)}`)
        }
        process.exit(0)
      } catch (error) {
        console.error((error as Error).message)
        process.exit(1)
      }
    })

  args.mcp
    .command('add-http <name> <url>')
    .description('Add a Streamable HTTP MCP server')
    .option(
      '-s, --scope <scope>',
      'Configuration scope (local, user, or project)',
      'local',
    )
    .option(
      '-H, --header <header...>',
      'Set headers (e.g. -H "X-Api-Key: abc123" -H "X-Custom: value")',
    )
    .action(async (name, url, options) => {
      const mcpClient = await loadMcpClient()
      try {
        const scopeInfo = normalizeMcpScopeForCli(options.scope)
        const headers = parseMcpHeaders(options.header)
        mcpClient.addMcpServer(
          name,
          { type: 'http', url, ...(headers ? { headers } : {}) },
          scopeInfo.scope,
        )
        console.log(
          `Added HTTP MCP server ${name} with URL: ${url} to ${scopeInfo.display} config`,
        )
        if (headers) {
          console.log(`Headers: ${JSON.stringify(headers, null, 2)}`)
        }
        process.exit(0)
      } catch (error) {
        console.error((error as Error).message)
        process.exit(1)
      }
    })

  args.mcp
    .command('add-ws <name> <url>')
    .description('Add a WebSocket MCP server')
    .option(
      '-s, --scope <scope>',
      'Configuration scope (local, user, or project)',
      'local',
    )
    .action(async (name, url, options) => {
      const mcpClient = await loadMcpClient()
      try {
        const scopeInfo = normalizeMcpScopeForCli(options.scope)
        mcpClient.addMcpServer(name, { type: 'ws', url }, scopeInfo.scope)
        console.log(
          `Added WebSocket MCP server ${name} with URL ${url} to ${scopeInfo.display} config`,
        )
        process.exit(0)
      } catch (error) {
        console.error((error as Error).message)
        process.exit(1)
      }
    })

  args.mcp
    .command('add [name] [commandOrUrl] [args...]')
    .description('Add a server (run without arguments for interactive wizard)')
    .option(
      '-s, --scope <scope>',
      'Configuration scope (local, user, or project)',
      'local',
    )
    .option(
      '-t, --transport <transport>',
      'MCP transport (stdio, sse, or http)',
    )
    .option(
      '-H, --header <header...>',
      'Set headers (e.g. -H "X-Api-Key: abc123" -H "X-Custom: value")',
    )
    .option(
      '-e, --env <env...>',
      'Set environment variables (e.g. -e KEY=value)',
    )
    .action(async (name, commandOrUrl, args, options) => {
      const mcpClient = await loadMcpClient()
      try {
        if (!name) {
          console.log('Interactive wizard mode: Enter the server details')
          const { createInterface } = await import('readline')
          const rl = createInterface({
            input: process.stdin,
            output: process.stdout,
          })

          const question = (query: string) =>
            new Promise<string>(resolve => rl.question(query, resolve))

          const serverName = await question('Server name: ')
          if (!serverName) {
            console.error('Error: Server name is required')
            rl.close()
            process.exit(1)
          }

          const serverType = await question(
            'Server type (stdio, http, sse, ws) [stdio]: ',
          )
          const type =
            serverType && ['stdio', 'http', 'sse', 'ws'].includes(serverType)
              ? serverType
              : 'stdio'

          const prompt = type === 'stdio' ? 'Command: ' : 'URL: '
          const commandOrUrlValue = await question(prompt)
          if (!commandOrUrlValue) {
            console.error(
              `Error: ${type === 'stdio' ? 'Command' : 'URL'} is required`,
            )
            rl.close()
            process.exit(1)
          }

          let serverArgs: string[] = []
          let serverEnv: Record<string, string> = {}

          if (type === 'stdio') {
            const argsStr = await question(
              'Command arguments (space-separated): ',
            )
            serverArgs = argsStr ? argsStr.split(' ').filter(Boolean) : []

            const envStr = await question(
              'Environment variables (KEY=value, comma-separated): ',
            )
            if (envStr) {
              const envPairs = envStr.split(',').filter(Boolean)
              serverEnv = mcpClient.parseEnvVars(envPairs.map(pair => pair))
            }
          }

          const scopeStr = await question(
            'Scope (local, user, project) [local]: ',
          )
          const scope =
            scopeStr && ['local', 'user', 'project'].includes(scopeStr)
              ? scopeStr
              : 'local'

          rl.close()

          const scopeInfo = normalizeMcpScopeForCli(scope)

          switch (type) {
            case 'http':
              mcpClient.addMcpServer(
                serverName,
                { type: 'http', url: commandOrUrlValue },
                scopeInfo.scope,
              )
              console.log(
                `Added HTTP MCP server ${serverName} with URL: ${commandOrUrlValue} to ${scopeInfo.display} config`,
              )
              break
            case 'sse':
              mcpClient.addMcpServer(
                serverName,
                { type: 'sse', url: commandOrUrlValue },
                scopeInfo.scope,
              )
              console.log(
                `Added SSE MCP server ${serverName} with URL: ${commandOrUrlValue} to ${scopeInfo.display} config`,
              )
              break
            case 'ws':
              mcpClient.addMcpServer(
                serverName,
                { type: 'ws', url: commandOrUrlValue },
                scopeInfo.scope,
              )
              console.log(
                `Added WebSocket MCP server ${serverName} with URL: ${commandOrUrlValue} to ${scopeInfo.display} config`,
              )
              break
            case 'stdio':
            default:
              mcpClient.addMcpServer(
                serverName,
                {
                  type: 'stdio',
                  command: commandOrUrlValue,
                  args: serverArgs,
                  env: serverEnv,
                },
                scopeInfo.scope,
              )
              console.log(
                `Added stdio MCP server ${serverName} with command: ${commandOrUrlValue} ${serverArgs.join(' ')} to ${scopeInfo.display} config`,
              )
              break
          }

          process.exit(0)
        } else if (name && commandOrUrl) {
          const scopeInfo = normalizeMcpScopeForCli(options.scope)
          const transportInfo = normalizeMcpTransport(options.transport)

          if (transportInfo.transport === 'stdio') {
            if (options.header?.length) {
              throw new Error(
                '--header can only be used with --transport http or --transport sse',
              )
            }

            const env = mcpClient.parseEnvVars(options.env)
            if (!transportInfo.explicit && looksLikeMcpUrl(commandOrUrl)) {
              console.warn(
                `Warning: "${commandOrUrl}" looks like a URL. Default transport is stdio, so it will be treated as a command.`,
              )
              console.warn(
                `If you meant to add an HTTP MCP server, run: ${PRODUCT_COMMAND} mcp add ${name} ${commandOrUrl} --transport http`,
              )
              console.warn(
                `If you meant to add a legacy SSE MCP server, run: ${PRODUCT_COMMAND} mcp add ${name} ${commandOrUrl} --transport sse`,
              )
            }

            mcpClient.addMcpServer(
              name,
              { type: 'stdio', command: commandOrUrl, args: args || [], env },
              scopeInfo.scope,
            )

            console.log(
              `Added stdio MCP server ${name} with command: ${commandOrUrl} ${(args || []).join(' ')} to ${scopeInfo.display} config`,
            )
          } else {
            if (options.env?.length) {
              throw new Error('--env is only supported for stdio MCP servers')
            }
            if (args?.length) {
              throw new Error(
                'Unexpected arguments. URL-based MCP servers do not accept command args.',
              )
            }

            const headers = parseMcpHeaders(options.header)
            mcpClient.addMcpServer(
              name,
              {
                type: transportInfo.transport,
                url: commandOrUrl,
                ...(headers ? { headers } : {}),
              },
              scopeInfo.scope,
            )

            const kind = transportInfo.transport.toUpperCase()
            console.log(
              `Added ${kind} MCP server ${name} with URL: ${commandOrUrl} to ${scopeInfo.display} config`,
            )
            if (headers) {
              console.log(`Headers: ${JSON.stringify(headers, null, 2)}`)
            }
          }
        } else {
          console.error(
            'Error: Missing required arguments. Either provide no arguments for interactive mode or specify name and command/URL.',
          )
          process.exit(1)
        }

        process.exit(0)
      } catch (error) {
        console.error((error as Error).message)
        process.exit(1)
      }
    })
}
