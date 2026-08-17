import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text } from 'ink'
import { getTheme } from '#core/utils/theme'
import { PressEnterToContinue } from '#ui-ink/components/PressEnterToContinue'
import { useKeypress } from '#ui-ink/hooks/useKeypress'
import { resolve } from 'node:path'
import { ScreenFrame } from '#ui-ink/primitives/layout/ScreenFrame'
import { useScreenLayout } from '#ui-ink/primitives/layout/useScreenLayout'
import {
  buildLspServerProcessEnv,
  listResolvedLspServers,
  resolveExecutableFromEnv,
} from '#tools/tools/system/LspTool/lspConfig'
import { getClients } from '#core/mcp/client/clients'
import {
  getCachedLspRuntimeStatus,
  type LspRuntimeServerStatus,
} from '#tools/tools/system/LspTool/call'

type Props = {
  onDone: () => void
}

type State =
  | { status: 'loading' }
  | {
      status: 'ready'
      servers: Awaited<ReturnType<typeof listResolvedLspServers>>
      runtime: {
        hasManager: boolean
        signature: string | null
        servers: LspRuntimeServerStatus[]
      }
      ideMcpConnected: boolean
    }
  | { status: 'error'; message: string }

function summarizeSource(source: { kind: string } | undefined): string {
  if (!source) return 'unknown'
  if (source.kind === 'plugin') return 'plugin'
  return source.kind
}

function resolveCommandPath(server: {
  command?: string
  env?: Record<string, string>
  workspaceFolder?: string
}): string | null {
  const command =
    typeof server.command === 'string' ? server.command.trim() : ''
  if (!command) return null

  const cwd =
    typeof server.workspaceFolder === 'string' && server.workspaceFolder.trim()
      ? resolve(server.workspaceFolder.trim())
      : process.cwd()

  const mergedEnv = buildLspServerProcessEnv({ cwd, env: server.env })
  return resolveExecutableFromEnv({
    command,
    cwd,
    env: mergedEnv,
  })
}

export function LspStatus({ onDone }: Props): React.ReactNode {
  const [state, setState] = useState<State>({ status: 'loading' })
  const theme = getTheme()
  const layout = useScreenLayout()

  useKeypress((_input, key) => {
    if (key.return || key.escape) onDone()
  })

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [servers, clients] = await Promise.all([
          listResolvedLspServers(),
          getClients(),
        ])
        const runtime = getCachedLspRuntimeStatus()
        const ideMcpConnected = clients.some(
          c => c.type === 'connected' && c.name === 'ide',
        )
        if (cancelled) return
        setState({
          status: 'ready',
          servers,
          runtime,
          ideMcpConnected,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (cancelled) return
        setState({ status: 'error', message })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const summary = useMemo(() => {
    if (state.status !== 'ready') return null

    return {
      resolvedCount: state.servers.length,
      servers: state.servers,
    }
  }, [state])

  if (state.status === 'loading') {
    return (
      <ScreenFrame
        title="LSP Status"
        paddingX={layout.paddingX}
        paddingY={layout.paddingY}
        gap={layout.gap}
      >
        <Text color={theme.secondaryText}>Checking LSP status…</Text>
      </ScreenFrame>
    )
  }

  if (state.status === 'error') {
    return (
      <ScreenFrame
        title="LSP Status"
        paddingX={layout.paddingX}
        paddingY={layout.paddingY}
        gap={layout.gap}
      >
        <Box flexDirection="column" gap={layout.gap}>
          <Text color={theme.error}>✘ LSP status check failed</Text>
          <Text color={theme.secondaryText}>{state.message}</Text>
          <PressEnterToContinue />
        </Box>
      </ScreenFrame>
    )
  }

  const runnablePreview = summary?.servers.slice(0, 12) ?? []
  const activeServers = state.runtime.servers.filter(s => s.state !== 'stopped')
  const runningServers = activeServers.filter(s => s.state === 'running')

  return (
    <ScreenFrame
      title="LSP Status"
      paddingX={layout.paddingX}
      paddingY={layout.paddingY}
      gap={layout.gap}
    >
      <Box flexDirection="column" gap={layout.gap}>
        <Box flexDirection="column" gap={0}>
          <Text color={theme.secondaryText}>
            IDE MCP connected: {state.ideMcpConnected ? 'yes' : 'no'}
          </Text>
        </Box>

        <Box flexDirection="column" gap={0}>
          <Text color={theme.success}>
            ✓ Resolved servers: {summary?.resolvedCount ?? 0}
          </Text>
        </Box>

        <Box flexDirection="column" gap={0}>
          <Text color={theme.secondaryText}>Active servers (this session)</Text>
          {!state.runtime.hasManager ? (
            <Text color={theme.secondaryText}>
              Not initialized yet. LSP servers start automatically once
              configured and initialized.
            </Text>
          ) : activeServers.length === 0 ? (
            <Text color={theme.secondaryText}>No servers running yet.</Text>
          ) : (
            <>
              <Text color={theme.secondaryText}>
                Running: {runningServers.length} · Active:{' '}
                {activeServers.length}
              </Text>
              {activeServers.slice(0, 8).map(s => (
                <Text
                  key={s.name}
                  color={
                    s.state === 'running' ? theme.success : theme.secondaryText
                  }
                >
                  • {s.name} — {s.state}
                  {s.pid ? ` (pid ${s.pid})` : ''}
                </Text>
              ))}
              {activeServers.length > 8 ? (
                <Text color={theme.secondaryText}>
                  …and {activeServers.length - 8} more
                </Text>
              ) : null}
            </>
          )}
        </Box>

        {summary && summary.resolvedCount > 0 ? (
          <Box flexDirection="column" gap={0}>
            <Text color={theme.secondaryText}>Configured servers</Text>
            {runnablePreview.map(server => {
              const extCount = Object.keys(
                server.extensionToLanguage ?? {},
              ).length
              const resolvedPath = resolveCommandPath(server)
              return (
                <Box key={server.name} flexDirection="column">
                  <Text color={theme.secondaryText}>
                    • {server.name} ({summarizeSource(server.source)}) —{' '}
                    {extCount} ext
                  </Text>
                  {resolvedPath ? (
                    <Text color={theme.secondaryText}>
                      {' '}
                      ↳ bin: {resolvedPath}
                    </Text>
                  ) : null}
                </Box>
              )
            })}
            {summary.servers.length > runnablePreview.length ? (
              <Text color={theme.secondaryText}>
                …and {summary.servers.length - runnablePreview.length} more
              </Text>
            ) : null}
          </Box>
        ) : (
          <Box flexDirection="column" gap={0}>
            <Text color={theme.warning}>No LSP servers configured.</Text>
            <Text color={theme.secondaryText}>
              Configure LSP servers via enabled plugins.
            </Text>
          </Box>
        )}

        <PressEnterToContinue />
      </Box>
    </ScreenFrame>
  )
}
