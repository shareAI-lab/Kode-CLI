import type { Command } from '@commander-js/extra-typings'

import type { McpServerConfig } from '#config'
import { renderWithTuiStdio } from '#ui-ink/utils/inkRender'

function loadMcpClient() {
  return import('#core/mcp/client')
}

/**
 * User-facing name for the config scope this import writes to. The success
 * message must match the actual target: `--scope global` writes the user
 * config, `--scope mcprc` writes .mcprc, etc.
 */
export function __scopeDisplayForImportForTests(scope: string): string {
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

export function registerMcpImportClaudeDesktopCommand(args: {
  mcp: Command
}): void {
  args.mcp
    .command('add-from-claude-desktop')
    .description(
      'Import MCP servers from a desktop MCP host config (macOS, Windows and WSL)',
    )
    .option(
      '-s, --scope <scope>',
      'Configuration scope (project, global, or mcprc)',
      'project',
    )
    .action(async options => {
      const mcpClient = await loadMcpClient()
      try {
        const scope = mcpClient.ensureConfigScope(options.scope)
        const platform = process.platform

        const { existsSync, readFileSync } = await import('fs')
        const { join } = await import('path')
        const { exec } = await import('child_process')

        const isWSL =
          platform === 'linux' &&
          existsSync('/proc/version') &&
          readFileSync('/proc/version', 'utf-8')
            .toLowerCase()
            .includes('microsoft')

        if (platform !== 'darwin' && platform !== 'win32' && !isWSL) {
          console.error(
            'Error: This command is only supported on macOS, Windows, and WSL',
          )
          process.exit(1)
        }

        let configPath: string
        if (platform === 'darwin') {
          configPath = join(
            process.env.HOME || '~',
            'Library/Application Support/Claude/claude_desktop_config.json',
          )
        } else if (platform === 'win32') {
          configPath = join(
            process.env.APPDATA || '',
            'Claude/claude_desktop_config.json',
          )
        } else {
          const whoamiCommand = await new Promise<string>((resolve, reject) => {
            exec(
              'powershell.exe -Command "whoami"',
              (err: Error | null, stdout: string) => {
                if (err) reject(err)
                else resolve(stdout.trim().split('\\').pop() || '')
              },
            )
          })

          configPath = `/mnt/c/Users/${whoamiCommand}/AppData/Roaming/Claude/claude_desktop_config.json`
        }

        if (!existsSync(configPath)) {
          console.error(`Error: Config file not found at ${configPath}`)
          process.exit(1)
        }

        let config: any
        try {
          const configContent = readFileSync(configPath, 'utf-8')
          config = JSON.parse(configContent)
        } catch (err) {
          console.error(`Error reading config file: ${err}`)
          process.exit(1)
        }

        const mcpServers = config.mcpServers || {}
        const serverNames = Object.keys(mcpServers)
        const numServers = serverNames.length

        if (numServers === 0) {
          console.log('No MCP servers found in the desktop config')
          process.exit(0)
        }

        const ink = await import('ink')
        const reactModule = await import('react')
        const utilsTheme = await import('#core/utils/theme')
        const uiFrame = await import('#ui-ink/primitives/layout/ScreenFrame')
        const uiLayout =
          await import('#ui-ink/primitives/layout/useScreenLayout')
        const uiMultiSelect =
          await import('#ui-ink/components/CustomSelect/multi-select')

        const { render } = ink
        const React = reactModule
        const { Box, Text } = ink
        const { getTheme } = utilsTheme
        const { ScreenFrame } = uiFrame
        const { useScreenLayout } = uiLayout
        const { ScopedMultiSelect } = uiMultiSelect

        await new Promise<void>(resolve => {
          function ClaudeDesktopImport() {
            const { useState } = reactModule
            const [isFinished, setIsFinished] = useState(false)
            const [importResults, setImportResults] = useState(
              [] as { name: string; success: boolean }[],
            )
            const theme = getTheme()
            const layout = useScreenLayout()

            const importServers = async (selectedServers: string[]) => {
              const results: Array<{ name: string; success: boolean }> = []

              for (const name of selectedServers) {
                try {
                  const server = mcpServers[name]
                  const existingServer = mcpClient.getMcpServer(name)
                  if (existingServer) continue
                  mcpClient.addMcpServer(name, server as McpServerConfig, scope)
                  results.push({ name, success: true })
                } catch {
                  results.push({ name, success: false })
                }
              }

              setImportResults(results)
              setIsFinished(true)

              setTimeout(() => {
                resolve()
              }, 1000)
            }

            const handleConfirm = async (selectedServers: string[]) => {
              const existingServers = selectedServers.filter(name =>
                mcpClient.getMcpServer(name),
              )

              if (existingServers.length > 0) {
                const results: Array<{ name: string; success: boolean }> = []

                const newServers = selectedServers.filter(
                  name => !mcpClient.getMcpServer(name),
                )
                for (const name of newServers) {
                  try {
                    const server = mcpServers[name]
                    mcpClient.addMcpServer(
                      name,
                      server as McpServerConfig,
                      scope,
                    )
                    results.push({ name, success: true })
                  } catch {
                    results.push({ name, success: false })
                  }
                }

                for (const name of existingServers) {
                  try {
                    const server = mcpServers[name]
                    mcpClient.addMcpServer(
                      name,
                      server as McpServerConfig,
                      scope,
                    )
                    results.push({ name, success: true })
                  } catch {
                    results.push({ name, success: false })
                  }
                }

                setImportResults(results)
                setIsFinished(true)

                setTimeout(() => {
                  resolve()
                }, 1000)
              } else {
                await importServers(selectedServers)
              }
            }

            return (
              <ScreenFrame
                title="Import MCP servers"
                titleColor={theme.kode}
                paddingX={layout.paddingX}
                paddingY={layout.paddingY}
                gap={layout.gap}
              >
                <Box flexDirection="column" gap={layout.gap}>
                  <Text dimColor wrap="truncate-end">
                    Found {numServers} servers in the desktop config.
                  </Text>

                  <Text>Select the servers you want to import:</Text>

                  <ScopedMultiSelect
                    focusScope={`mcp-import-claude-desktop:${scope}`}
                    options={serverNames.map(name => ({
                      label: name,
                      value: name,
                    }))}
                    defaultValue={serverNames}
                    visibleOptionCount={Math.min(
                      12,
                      Math.max(3, serverNames.length),
                    )}
                    onSubmit={handleConfirm}
                  />

                  <Text dimColor wrap="truncate-end">
                    Space select · Enter confirm · Esc cancel
                  </Text>

                  {isFinished ? (
                    <Text color={theme.success} wrap="truncate-end">
                      Imported {importResults.filter(r => r.success).length}{' '}
                      servers to {__scopeDisplayForImportForTests(scope)}{' '}
                      config.
                    </Text>
                  ) : null}
                </Box>
              </ScreenFrame>
            )
          }

          const instance = renderWithTuiStdio(render, <ClaudeDesktopImport />)

          setTimeout(() => {
            instance.unmount?.()
            resolve()
          }, 30_000)
        })

        process.exit(0)
      } catch (error) {
        console.error(`Error: ${(error as Error).message}`)
        process.exit(1)
      }
    })
}
