import { afterEach, describe, expect, test, mock } from 'bun:test'
import React from 'react'
import { KeypressProvider } from '#ui-ink/contexts/KeypressContext'
import { useKeypress } from '#ui-ink/hooks/useKeypress'
import { ModelPickerScreen } from '#ui-ink/screens/overlays/ModelPickerScreen'
import { ThinkingToggleScreen } from '#ui-ink/screens/overlays/ThinkingToggleScreen'
import { ConfigScreen } from '#ui-ink/screens/overlays/ConfigScreen'
import { WorkTasksScreen } from '#ui-ink/screens/overlays/WorkTasksScreen'
import { TranscriptScreen } from '#ui-ink/screens/overlays/TranscriptScreen'
import { CommandPaletteScreen } from '#ui-ink/screens/overlays/CommandPaletteScreen'
import { ThemePickerScreen } from '#ui-ink/screens/overlays/ThemePickerScreen'
import type { Command } from '#cli-commands'
import { createInkHarnessManager, createInkTestHarness } from './inkTestHarness'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getGlobalConfig, saveGlobalConfig } from '#core/utils/config'
import { reloadModelManager } from '#core/utils/model'

const harnessManager = createInkHarnessManager()

async function waitForOutput(
  harness: ReturnType<typeof createInkTestHarness>,
  expected: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (harness.getOutput().includes(expected)) {
      // Ink can render a route before that route's key handler effect commits.
      await harness.wait(50)
      return
    }
    await harness.wait(20)
  }
  const output = harness.getOutput()
  throw new Error(
    `Timed out waiting for overlay output: ${expected}\n${output.slice(-4_000)}`,
  )
}

async function typeFilter(
  harness: ReturnType<typeof createInkTestHarness>,
  value: string,
): Promise<void> {
  await harness.wait(50)
  let prefix = ''
  for (const character of value) {
    harness.stdin.write(character)
    prefix += character
    await waitForOutput(harness, `Filter: ${prefix}`)
  }
}

afterEach(async () => {
  await harnessManager.cleanup()
})

describe('TUI E2E regression (Ink render): Overlays', () => {
  test('TranscriptScreen: Ctrl+C closes', async () => {
    let closed = false
    const h = createInkTestHarness(
      <KeypressProvider>
        <TranscriptScreen
          label="test"
          onDone={() => {
            closed = true
          }}
        />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(25)
    h.stdin.write('\x03')
    await h.wait(25)

    expect(closed).toBe(true)
  })

  test('WorkTasksScreen: Ctrl+T closes', async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'kode-worktasks-overlay-'))
    const previousConfigDir = process.env.KODE_CONFIG_DIR
    const previousTaskListId = process.env.KODE_TASK_LIST_ID
    process.env.KODE_CONFIG_DIR = tmpRoot
    process.env.KODE_TASK_LIST_ID = 'overlay-test'

    let closed = false
    try {
      const h = createInkTestHarness(
        <KeypressProvider>
          <WorkTasksScreen
            onDone={() => {
              closed = true
            }}
          />
        </KeypressProvider>,
      )
      harnessManager.track(h)

      await h.wait(25)
      h.stdin.write('\x14')
      await h.wait(25)

      expect(closed).toBe(true)
    } finally {
      if (previousConfigDir === undefined) delete process.env.KODE_CONFIG_DIR
      else process.env.KODE_CONFIG_DIR = previousConfigDir

      if (previousTaskListId === undefined) delete process.env.KODE_TASK_LIST_ID
      else process.env.KODE_TASK_LIST_ID = previousTaskListId

      rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  test('ModelPickerScreen: Alt+P closes', async () => {
    let closed = false
    const h = createInkTestHarness(
      <KeypressProvider>
        <ModelPickerScreen
          onDone={() => {
            closed = true
          }}
          onSelectModel={() => {}}
        />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(25)
    h.stdin.write('\x1bp')
    await h.wait(25)

    expect(closed).toBe(true)
  })

  test('ModelPickerScreen: SGR mouse click selects a model', async () => {
    const originalConfig = JSON.parse(JSON.stringify(getGlobalConfig()))
    saveGlobalConfig({
      ...getGlobalConfig(),
      modelProfiles: [
        {
          name: 'Code Model',
          provider: 'custom-openai',
          modelName: 'code-model',
          apiKey: 'test-key',
          maxTokens: 1024,
          contextLength: 128_000,
          isActive: true,
          createdAt: 1,
          lastUsed: 2,
        },
        {
          name: 'Other Model',
          provider: 'custom-openai',
          modelName: 'other-model',
          apiKey: 'test-key',
          maxTokens: 1024,
          contextLength: 128_000,
          isActive: true,
          createdAt: 2,
          lastUsed: 1,
        },
      ],
      modelPointers: {
        main: 'code-model',
        task: '',
        compact: '',
        quick: '',
      },
    })
    reloadModelManager()

    try {
      let selectedModel = ''
      let closed = false
      const h = createInkTestHarness(
        <KeypressProvider>
          <ModelPickerScreen
            onDone={() => {
              closed = true
            }}
            onSelectModel={modelName => {
              selectedModel = modelName
            }}
          />
        </KeypressProvider>,
      )
      harnessManager.track(h)

      await h.wait(25)
      const outputLines = h.getOutput().split(/\r?\n/)
      const modelLineIndex = outputLines.findIndex(line =>
        line.includes('Other Model'),
      )
      expect(modelLineIndex).toBeGreaterThanOrEqual(0)

      h.stdin.write(`\x1b[<0;4;${modelLineIndex + 1}M`)
      await h.wait(25)

      expect(selectedModel).toBe('other-model')
      expect(closed).toBe(true)
    } finally {
      saveGlobalConfig(originalConfig)
      reloadModelManager()
    }
  })

  test('ModelPickerScreen: typing filters and applies the matching model', async () => {
    const originalConfig = JSON.parse(JSON.stringify(getGlobalConfig()))
    saveGlobalConfig({
      ...getGlobalConfig(),
      modelProfiles: [
        {
          name: 'Code Model',
          provider: 'custom-openai',
          modelName: 'code-model',
          apiKey: 'test-key',
          maxTokens: 1024,
          contextLength: 128_000,
          isActive: true,
          createdAt: 1,
          lastUsed: 2,
        },
        {
          name: 'Other Model',
          provider: 'custom-openai',
          modelName: 'other-model',
          apiKey: 'test-key',
          maxTokens: 1024,
          contextLength: 128_000,
          isActive: true,
          createdAt: 2,
          lastUsed: 1,
        },
      ],
      modelPointers: {
        main: 'code-model',
        task: '',
        compact: '',
        quick: '',
      },
    })
    reloadModelManager()

    try {
      let selectedModel = ''
      let closed = false
      const h = createInkTestHarness(
        <KeypressProvider>
          <ModelPickerScreen
            onDone={() => {
              closed = true
            }}
            onSelectModel={modelName => {
              selectedModel = modelName
            }}
          />
        </KeypressProvider>,
      )
      harnessManager.track(h)

      await waitForOutput(h, 'Current: Code Model')
      await typeFilter(h, 'other')

      expect(h.getOutput()).toContain('Filter: other')
      expect(h.getOutput()).toContain(
        '1 match · Enter applies the highlighted model',
      )

      h.stdin.write('\r')
      await h.wait(25)

      expect(selectedModel).toBe('other-model')
      expect(closed).toBe(true)
    } finally {
      saveGlobalConfig(originalConfig)
      reloadModelManager()
    }
  })

  test('ModelPickerScreen: Ctrl+O opens model configuration directly', async () => {
    let openedConfig = false
    const h = createInkTestHarness(
      <KeypressProvider>
        <ModelPickerScreen
          onDone={() => {}}
          onSelectModel={() => {}}
          onOpenModelConfig={() => {
            openedConfig = true
          }}
        />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(25)
    h.stdin.write('\x0f')
    await h.wait(25)

    expect(openedConfig).toBe(true)
  })

  test('ThemePickerScreen: typing filters and applies the matching theme', async () => {
    const originalConfig = JSON.parse(JSON.stringify(getGlobalConfig()))
    saveGlobalConfig({ ...getGlobalConfig(), theme: 'dark' })

    try {
      let result = ''
      const h = createInkTestHarness(
        <KeypressProvider>
          <ThemePickerScreen onDone={value => (result = value ?? '')} />
        </KeypressProvider>,
      )
      harnessManager.track(h)

      await waitForOutput(h, 'Current: Dark')
      await typeFilter(h, 'nord')

      expect(h.getOutput()).toContain('Filter: nord')
      expect(h.getOutput()).toContain(
        '1 match · Enter applies the highlighted theme',
      )

      h.stdin.write('\r')
      await h.wait(25)

      expect(result).toBe('Theme set to nord')
      expect(getGlobalConfig().theme).toBe('nord')
    } finally {
      saveGlobalConfig(originalConfig)
    }
  })

  test('ThinkingToggleScreen: Alt+T closes', async () => {
    let closed = false
    const h = createInkTestHarness(
      <KeypressProvider>
        <ThinkingToggleScreen
          currentValue={false}
          isMidConversation={false}
          onSelect={() => {}}
          onDone={() => {
            closed = true
          }}
        />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(25)
    h.stdin.write('\x1bt')
    await h.wait(25)

    expect(closed).toBe(true)
  })

  test('ThinkingToggleScreen: SGR mouse click selects an option', async () => {
    let selected: boolean | null = null
    let closed = false
    const h = createInkTestHarness(
      <KeypressProvider>
        <ThinkingToggleScreen
          currentValue={false}
          isMidConversation={false}
          onSelect={value => {
            selected = value
          }}
          onDone={() => {
            closed = true
          }}
        />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(25)
    const outputLines = h.getOutput().split(/\r?\n/)
    const enabledLineIndex = outputLines.findIndex(line =>
      line.includes('Enabled'),
    )
    expect(enabledLineIndex).toBeGreaterThanOrEqual(0)

    h.stdin.write(`\x1b[<0;4;${enabledLineIndex + 1}M`)
    await h.wait(25)

    expect(selected).toBe(true)
    expect(closed).toBe(true)
  })

  test('ConfigScreen: SGR mouse click toggles a setting row', async () => {
    const originalConfig = JSON.parse(JSON.stringify(getGlobalConfig()))
    saveGlobalConfig({
      ...getGlobalConfig(),
      stream: true,
    })

    try {
      const h = createInkTestHarness(
        <KeypressProvider>
          <ConfigScreen onClose={() => {}} />
        </KeypressProvider>,
      )
      harnessManager.track(h)

      await h.wait(25)
      const outputLines = h.getOutput().split(/\r?\n/)
      const streamLineIndex = outputLines.findIndex(line =>
        line.includes('Stream responses'),
      )
      expect(streamLineIndex).toBeGreaterThanOrEqual(0)

      h.stdin.write(`\x1b[<0;4;${streamLineIndex + 1}M`)
      await h.wait(25)

      expect(getGlobalConfig().stream).toBe(false)
    } finally {
      saveGlobalConfig(originalConfig)
    }
  })

  test('HistorySearchScreen: Enter triggers accept', async () => {
    try {
      mock.module('#core/history', () => {
        return {
          addToHistory: () => {},
          getHistoryWithPastes: () => [],
          getGlobalHistoryWithPastes: () => [
            { display: 'hello', pastedTexts: [] },
            { display: '!ls', pastedTexts: [] },
          ],
        }
      })

      const { HistorySearchScreen } =
        await import('#ui-ink/screens/overlays/HistorySearchScreen')

      let result: any = null
      const h = createInkTestHarness(
        <KeypressProvider>
          <HistorySearchScreen onDone={r => (result = r)} />
        </KeypressProvider>,
      )
      harnessManager.track(h)

      await h.wait(25)
      h.stdin.write('\r')
      await h.wait(25)

      expect(result).toEqual({
        action: 'accept',
        value: 'hello',
        pastedTexts: [],
      })
    } finally {
      mock.restore()
    }
  })

  test('CommandPaletteScreen: Ctrl+A and Ctrl+E stay inside the filter input', async () => {
    const h = createInkTestHarness(
      <KeypressProvider>
        <CommandPaletteScreen onDone={() => {}} />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(100)
    h.stdin.write('open')
    await h.wait(50)

    h.clearOutput()
    h.stdin.write('\x01')
    h.stdin.write('help')
    await h.wait(50)

    expect(h.getOutput()).toContain('helpopen')
    expect(h.getOutput()).not.toContain('openhelp')

    h.clearOutput()
    h.stdin.write('\x05')
    h.stdin.write('x')
    await h.wait(50)

    expect(h.getOutput()).toContain('helpopenx')
    expect(h.getOutput()).not.toContain('helpxopen')
  })

  test('CommandPaletteScreen: filters slash commands by alias and returns a draft', async () => {
    const command = {
      type: 'local',
      name: 'deploy',
      description: 'Deploy the current project',
      argumentHint: '<environment>',
      aliases: ['ship'],
      isEnabled: true,
      isHidden: false,
      userFacingName: () => 'deploy',
      call: async () => '',
    } satisfies Command
    let result: unknown

    const h = createInkTestHarness(
      <KeypressProvider>
        <CommandPaletteScreen
          commands={[command]}
          onDone={value => (result = value)}
        />
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await h.wait(50)
    h.stdin.write('/ship')
    await h.wait(50)

    expect(h.getOutput()).toContain('/deploy <environment>')
    expect(h.getOutput()).toContain('Aliases: /ship')

    h.stdin.write('\r')
    await h.wait(25)

    expect(result).toEqual({
      kind: 'command',
      name: 'deploy',
      argumentHint: '<environment>',
    })
  })

  test('LogList: Enter returns selected log JSON through callback', async () => {
    let mockLogs = [
      {
        date: '2026-07-08',
        fullPath: 'log.json',
        value: 0,
        created: new Date('2026-07-08T12:00:00Z'),
        modified: new Date('2026-07-08T12:00:00Z'),
        firstPrompt: 'hello',
        messageCount: 1,
        messages: [
          {
            type: 'user',
            uuid: '00000000-0000-4000-8000-000000000001',
            message: {
              role: 'user',
              content: 'hello',
            },
            timestamp: '2026-07-08T12:00:00Z',
          },
        ],
      },
    ]

    try {
      mock.module('#core/utils/log', () => {
        return {
          CACHE_PATHS: {
            messages: () => 'messages',
            errors: () => 'errors',
          },
          formatDate: () => '2026-07-08 12:00',
          loadLogList: async () => mockLogs,
          logError: () => {},
        }
      })

      const { LogList } = await import('#ui-ink/screens/LogList')
      let result: any = null
      const h = createInkTestHarness(
        <KeypressProvider>
          <LogList
            context={{}}
            type="messages"
            onDone={nextResult => {
              result = nextResult
            }}
          />
        </KeypressProvider>,
      )
      harnessManager.track(h)

      await h.wait(50)
      expect(h.getOutput()).toContain('hello')

      h.stdin.write('\r')
      await h.wait(50)

      expect(result).toMatchObject({ type: 'stdout', exitCode: 0 })
      expect(result.text).toContain('00000000-0000-4000-8000-000000000001')
      expect(h.getOutput()).not.toContain('"uuid"')

      mockLogs = []
      let emptyResult: any = null
      const emptyHarness = createInkTestHarness(
        <KeypressProvider>
          <LogList
            context={{}}
            type="messages"
            onDone={nextResult => {
              emptyResult = nextResult
            }}
          />
        </KeypressProvider>,
      )
      harnessManager.track(emptyHarness)

      await emptyHarness.wait(50)
      expect(emptyResult).toEqual({
        type: 'stderr',
        text: 'No message logs found.\n',
        exitCode: 1,
      })
    } finally {
      mock.restore()
    }
  })

  test('McpServersScreen: resources and prompts can be opened from a connected server', async () => {
    let reconnectCount = 0
    let getClientsCallCount = 0
    let promptsEnabled = false
    let promptRevision = 0
    let resourceRevision = 0
    let resourceTemplateRevision = 0
    let leakedEscapes = 0
    const subscribedResources: string[] = []
    const unsubscribedResources: string[] = []
    let listChangedListener:
      ((event: { kind: string; server: string }) => void) | null = null
    let resourceUpdatedListener:
      ((event: { server: string; uri: string }) => void) | null = null

    function EscapeLeakSpy(): React.ReactNode {
      useKeypress(
        (_input, key) => {
          if (!key.escape) return
          leakedEscapes += 1
          return true
        },
        { priority: -100 },
      )
      return null
    }

    const reviewPrompt = {
      type: 'prompt',
      name: 'mcp__srv__review',
      description: 'Review the current diff',
      isEnabled: true,
      isHidden: false,
      progressMessage: 'running',
      argNames: ['scope'],
      userFacingName: () => 'srv:Review Diff (MCP)',
      getPromptForCommand: async () => [],
    }

    const summarizePrompt = {
      type: 'prompt',
      name: 'mcp__srv__summarize',
      description: 'Summarize recent project changes',
      isEnabled: true,
      isHidden: false,
      progressMessage: 'running',
      argNames: [],
      userFacingName: () => 'srv:Summarize Changes (MCP)',
      getPromptForCommand: async () => [],
    }

    const readmeResource = {
      server: 'srv',
      uri: 'file:///project/README.md',
      name: 'README.md',
      title: 'Project README',
      description: 'Primary project documentation',
      mimeType: 'text/markdown',
      size: 2048,
      annotations: {
        audience: ['user'],
        priority: 0.7,
        lastModified: '2026-07-08T00:00:00Z',
      },
    }

    const guideResource = {
      server: 'srv',
      uri: 'file:///project/GUIDE.md',
      name: 'GUIDE.md',
      title: 'Project Guide',
      description: 'Updated project guide',
      mimeType: 'text/markdown',
      size: 1024,
    }

    const fileTemplate = {
      server: 'srv',
      uriTemplate: 'file:///{path}',
      name: 'project-file',
      title: 'Project Files',
      description: 'Open files by project-relative path',
      mimeType: 'text/plain',
      annotations: {
        audience: ['assistant'],
        priority: 0.6,
        lastModified: '2026-07-09T00:00:00Z',
      },
    }

    const guideTemplate = {
      server: 'srv',
      uriTemplate: 'file:///guides/{slug}.md',
      name: 'guide-file',
      title: 'Guide Files',
      description: 'Open guide files by slug',
      mimeType: 'text/markdown',
    }

    try {
      mock.module('#core/mcp/client', () => {
        return {
          authenticateMcpServer: async () => {},
          clearMcpAuth: async () => {},
          formatMcpClientCapabilitySummary: () => [
            'roots: enabled (listChanged)',
            'sampling: disabled',
            'elicitation: disabled',
          ],
          getClients: async () => {
            getClientsCallCount += 1
            const connectedClient = {
              type: 'connected',
              name: 'srv',
              capabilities: {
                resources: { subscribe: true },
                logging: {},
                completions: {},
              },
            }
            if (getClientsCallCount === 2) {
              await new Promise(resolve => setTimeout(resolve, 220))
              return [{ type: 'failed', name: 'srv' }]
            }
            if (getClientsCallCount === 3) {
              await new Promise(resolve => setTimeout(resolve, 20))
              return [connectedClient]
            }
            return [connectedClient]
          },
          getMcpAuthSnapshot: () => ({ isAuthenticated: false }),
          getMcpClientCapabilitySummary: () => ({
            roots: { enabled: true, listChanged: true },
            sampling: { enabled: false },
            elicitation: { enabled: false },
          }),
          getMcpListChangedVersion: () => 0,
          getMCPCommands: async () =>
            !promptsEnabled
              ? []
              : promptRevision === 0
                ? [reviewPrompt]
                : [reviewPrompt, summarizePrompt],
          getMCPResources: async () => {
            await new Promise(resolve => setTimeout(resolve, 220))
            return resourceRevision === 0
              ? [readmeResource]
              : [readmeResource, guideResource]
          },
          getMCPResourceTemplates: async () =>
            resourceTemplateRevision === 0
              ? [fileTemplate]
              : [fileTemplate, guideTemplate],
          getMCPTools: async () => [],
          MCP_LOGGING_LEVELS: [
            'debug',
            'info',
            'notice',
            'warning',
            'error',
            'critical',
            'alert',
            'emergency',
          ],
          getMcprcServerStatus: () => 'approved',
          getMcpServer: () => ({
            scope: 'global',
            configLocation: 'test-config.json',
          }),
          listMCPServers: () => ({
            srv: { type: 'stdio', command: 'node', args: ['server.js'] },
          }),
          resetMcpConnections: async () => {
            reconnectCount += 1
          },
          setMcpLoggingLevel: async (_args: {
            server: string
            level: string
          }) => {},
          subscribeMCPResource: async ({
            server,
            uri,
          }: {
            server: string
            uri: string
          }) => {
            subscribedResources.push(`${server}:${uri}`)
          },
          unsubscribeMCPResource: async ({
            server,
            uri,
          }: {
            server: string
            uri: string
          }) => {
            unsubscribedResources.push(`${server}:${uri}`)
          },
          subscribeMcpListChanged: (
            listener: (event: { kind: string; server: string }) => void,
          ) => {
            listChangedListener = listener
            return () => {
              if (listChangedListener === listener) listChangedListener = null
            }
          },
          subscribeMcpResourceUpdated: (
            listener: (event: { server: string; uri: string }) => void,
          ) => {
            resourceUpdatedListener = listener
            return () => {
              if (resourceUpdatedListener === listener)
                resourceUpdatedListener = null
            }
          },
        }
      })
      mock.module('#core/utils/config', () => {
        return {
          getCurrentProjectConfig: () => ({ disabledMcpServers: [] }),
          getGlobalConfig: () => ({ disabledMcpServers: [] }),
          getProjectMcpServerDefinitions: () => ({
            mcprcPath: 'test-mcprc.json',
            mcpJsonPath: 'test-mcp.json',
          }),
          saveCurrentProjectConfig: () => {},
          saveGlobalConfig: () => {},
        }
      })
      mock.module('#core/utils/env', () => {
        return {
          getGlobalConfigFilePath: () => 'test-global-config.json',
        }
      })
      mock.module('#core/utils/state', () => {
        return {
          getCwd: () => 'C:\\test',
        }
      })

      const { McpServersScreen } =
        await import('#ui-ink/screens/overlays/McpServersScreen')

      const originalExit = process.exit
      let processExitCalled = false
      let ctrlCClosed = false
      try {
        ;(process as any).exit = (() => {
          processExitCalled = true
          return undefined as never
        }) as typeof process.exit

        const closeHarness = createInkTestHarness(
          <KeypressProvider>
            <McpServersScreen
              onDone={() => {
                ctrlCClosed = true
              }}
            />
          </KeypressProvider>,
        )
        harnessManager.track(closeHarness)

        await closeHarness.wait(250)
        closeHarness.stdin.write('\x03')
        await closeHarness.wait(40)

        expect(ctrlCClosed).toBe(false)
        expect(processExitCalled).toBe(false)
        expect(closeHarness.getOutput()).toContain('again to close')

        closeHarness.stdin.write('\x03')
        await closeHarness.wait(40)

        expect(ctrlCClosed).toBe(true)
        expect(processExitCalled).toBe(false)
        closeHarness.unmount()
        getClientsCallCount = 0
      } finally {
        process.exit = originalExit
      }

      const h = createInkTestHarness(
        <KeypressProvider>
          <>
            <McpServersScreen onDone={() => {}} />
            <EscapeLeakSpy />
          </>
        </KeypressProvider>,
      )
      harnessManager.track(h)

      await h.wait(250)
      expect(h.getOutput()).toContain('srv')
      expect(h.getOutput()).toContain('Client capabilities:')
      expect(h.getOutput()).toContain('roots: enabled')

      h.stdin.write('\r')
      await h.wait(100)
      if (!h.getOutput().includes('Loading actions...')) {
        await waitForOutput(h, 'Loading actions...')
      }

      expect(h.getOutput()).toContain('Loading actions...')

      h.stdin.write('\x1b')
      await h.wait(250)
      expect(h.getOutput()).toContain('srv')
      expect(leakedEscapes).toBe(0)

      h.clearOutput()
      h.stdin.write('\r')
      await h.wait(100)
      if (!h.getOutput().includes('Loading actions...')) {
        await waitForOutput(h, 'Loading actions...')
      }
      const reenteredLoadingOutput = h.getOutput()
      expect(reenteredLoadingOutput).toContain('Loading actions...')
      expect(reenteredLoadingOutput).toContain('Capabilities:')
      expect(reenteredLoadingOutput).toContain('Kode client:')
      expect(reenteredLoadingOutput).toContain('loading...')
      expect(reenteredLoadingOutput).not.toContain('Resources: 1 resources')
      expect(reenteredLoadingOutput).not.toContain('Prompts: 1 prompts')
      expect(reenteredLoadingOutput).not.toContain('1. View prompts')

      h.stdin.write('\r')
      await h.wait(350)
      if (!h.getOutput().includes('Resources: 1 resources')) {
        await waitForOutput(h, 'Resources: 1 resources')
      }

      expect(h.getOutput()).toContain('Resources: 1 resources')
      expect(h.getOutput()).toContain(
        'Capabilities: resources, logging, completions',
      )
      expect(h.getOutput()).toContain('Set log level: warning')
      expect(h.getOutput()).toContain('Set log level: info')
      expect(h.getOutput()).toContain('1. View resources')
      expect(h.getOutput()).toContain('2. View resource templates')
      expect(h.getOutput()).toContain('Resource templates: 1 template')
      expect(reconnectCount).toBe(0)

      h.stdin.write('2')
      await h.wait(120)
      if (!h.getOutput().includes('Project Files')) {
        await waitForOutput(h, 'Project Files')
      }
      expect(h.getOutput()).toContain('Resource templates for srv')
      expect(h.getOutput()).toContain('Project Files')

      resourceTemplateRevision = 1
      listChangedListener?.({ kind: 'resources', server: 'srv' })
      await h.wait(120)
      if (!h.getOutput().includes('Guide Files')) {
        await waitForOutput(h, 'Guide Files')
      }
      expect(h.getOutput()).toContain('Guide Files')

      h.stdin.write('1')
      await h.wait(80)
      if (!h.getOutput().includes('Template name: project-file')) {
        await waitForOutput(h, 'Template name: project-file')
      }
      expect(h.getOutput()).toContain('Template name: project-file')
      expect(h.getOutput()).toContain('URI template: file:///{path}')
      expect(h.getOutput()).toContain('MIME type: text/plain')
      expect(h.getOutput()).toContain('Open files by project-relative path')
      expect(h.getOutput()).toContain('audience: assistant')

      h.stdin.write('\x1b')
      await h.wait(80)
      h.stdin.write('\x1b')
      await h.wait(350)

      let resourcesOutput = ''
      h.clearOutput()
      for (let attempt = 0; attempt < 8; attempt += 1) {
        h.stdin.write('1')
        await h.wait(300)
        resourcesOutput = h.getOutput()
        if (resourcesOutput.includes('Project README')) break
        if (resourcesOutput.includes('Resources for srv')) {
          await waitForOutput(h, 'Project README')
          resourcesOutput = h.getOutput()
          break
        }
        h.clearOutput()
      }
      expect(resourcesOutput).toContain('Resources for srv')
      expect(resourcesOutput).toContain('Project README')

      resourceRevision = 1
      listChangedListener?.({ kind: 'resources', server: 'srv' })
      await h.wait(300)
      if (!h.getOutput().includes('Project Guide')) {
        await waitForOutput(h, 'Project Guide')
      }
      expect(h.getOutput()).toContain('Project Guide')

      h.stdin.write('\r')
      await h.wait(80)
      if (!h.getOutput().includes('Resource name: README.md')) {
        await waitForOutput(h, 'Resource name: README.md')
      }
      const output = h.getOutput()
      expect(output).toContain('Resource name: README.md')
      expect(output).toContain('URI: file:///project/README.md')
      expect(output).toContain('MIME type: text/markdown')
      expect(output).toContain('Size: 2.0 KiB')
      expect(output).toContain('Primary project documentation')
      expect(output).toContain('audience: user')
      expect(output).toContain('subscription: available')
      expect(output).toContain('Press s to subscribe')

      h.stdin.write('s')
      await h.wait(120)
      expect(subscribedResources).toEqual(['srv:file:///project/README.md'])
      expect(h.getOutput()).toContain('subscription: subscribed')
      expect(h.getOutput()).toContain('Press u to unsubscribe')

      resourceUpdatedListener?.({
        server: 'srv',
        uri: 'file:///project/README.md',
      })
      await h.wait(80)
      expect(h.getOutput()).toContain('received updates: 1')

      h.stdin.write('u')
      await h.wait(120)
      expect(unsubscribedResources).toEqual(['srv:file:///project/README.md'])
      expect(h.getOutput()).toContain('subscription: available')

      h.stdin.write('s')
      await h.wait(120)
      expect(subscribedResources).toEqual([
        'srv:file:///project/README.md',
        'srv:file:///project/README.md',
      ])
      expect(h.getOutput()).toContain('subscription: subscribed')

      h.stdin.write('\x1b')
      await h.wait(80)
      h.stdin.write('\x1b')
      h.clearOutput()

      async function waitForStableReconnectAction(): Promise<string> {
        let lastOutput = ''
        for (let attempt = 0; attempt < 12; attempt += 1) {
          await h.wait(100)
          const output = h.getOutput()
          lastOutput = output

          if (output.includes('Loading actions...')) {
            h.clearOutput()
            continue
          }

          if (output.includes('Reconnect')) {
            h.clearOutput()
            await h.wait(100)
            const quietOutput = h.getOutput()
            if (quietOutput.includes('Loading actions...')) {
              h.clearOutput()
              continue
            }
            return output + quietOutput
          }
        }
        return lastOutput
      }

      async function reconnectOnce(): Promise<void> {
        const serverActionsOutput = await waitForStableReconnectAction()
        expect(serverActionsOutput).toContain('Reconnect')

        h.clearOutput()
        if (serverActionsOutput.includes('1. Reconnect')) {
          h.stdin.write('\r')
        } else if (serverActionsOutput.includes('3. Reconnect')) {
          h.stdin.write('3')
        } else {
          h.stdin.write('\x1B[B')
          await h.wait(80)
          expect(h.getOutput()).toContain('❯2. Reconnect')
          h.stdin.write('\r')
        }

        h.clearOutput()
        await h.wait(300)
      }

      await reconnectOnce()
      await reconnectOnce()

      expect(reconnectCount).toBe(2)
      expect(leakedEscapes).toBe(0)

      let resourcesAfterReconnect = ''
      h.clearOutput()
      for (let attempt = 0; attempt < 8; attempt += 1) {
        h.stdin.write('1')
        await h.wait(300)
        resourcesAfterReconnect = h.getOutput()
        if (resourcesAfterReconnect.includes('Project README')) break
        if (resourcesAfterReconnect.includes('Resources for srv')) {
          await waitForOutput(h, 'Project README')
          resourcesAfterReconnect = h.getOutput()
          break
        }
        h.clearOutput()
      }
      expect(resourcesAfterReconnect).toContain('Resources for srv')
      expect(resourcesAfterReconnect).toContain('Project README')

      // Wait for the resource-list key handler to commit before selecting the
      // focused resource. Rendering can precede the effect on slower runners.
      await h.wait(100)
      h.stdin.write('\r')
      await h.wait(120)
      if (!h.getOutput().includes('Resource name: README.md')) {
        await waitForOutput(h, 'Resource name: README.md')
      }
      const resourceAfterReconnect = h.getOutput()
      expect(resourceAfterReconnect).toContain('Resource name: README.md')
      expect(resourceAfterReconnect).toContain('subscription: available')
      expect(resourceAfterReconnect).not.toContain('subscription: subscribed')
      expect(resourceAfterReconnect).not.toContain('received updates: 1')

      h.unmount()
      promptsEnabled = true
      promptRevision = 0
      listChangedListener = null

      const promptHarness = createInkTestHarness(
        <KeypressProvider>
          <McpServersScreen onDone={() => {}} />
        </KeypressProvider>,
      )
      harnessManager.track(promptHarness)

      await waitForOutput(promptHarness, 'srv')
      expect(promptHarness.getOutput()).toContain('srv')

      promptHarness.stdin.write('\r')
      await waitForOutput(promptHarness, 'Prompts: 1 prompts')
      expect(promptHarness.getOutput()).toContain('Prompts: 1 prompts')
      expect(promptHarness.getOutput()).toContain('1. View prompts')

      promptHarness.stdin.write('\r')
      await waitForOutput(promptHarness, 'Review Diff')
      expect(promptHarness.getOutput()).toContain('Prompts for srv')
      expect(promptHarness.getOutput()).toContain('Review Diff')

      promptRevision = 1
      listChangedListener?.({ kind: 'prompts', server: 'srv' })
      await waitForOutput(promptHarness, 'Summarize Changes')
      expect(promptHarness.getOutput()).toContain('Summarize Changes')

      promptHarness.stdin.write('\r')
      await waitForOutput(promptHarness, 'Prompt command: mcp__srv__review')
      expect(promptHarness.getOutput()).toContain(
        'Prompt command: mcp__srv__review',
      )
      expect(promptHarness.getOutput()).toContain('Arguments: scope')
      expect(promptHarness.getOutput()).toContain('Review the current diff')
    } finally {
      mock.restore()
    }
  }, 15000)
})
