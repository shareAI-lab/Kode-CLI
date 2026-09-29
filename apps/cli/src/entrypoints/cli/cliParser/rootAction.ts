import type { RenderOptions } from 'ink'

import { runPrintMode } from '../print/runPrintMode'
import { setup } from '../setup'
import { showSetupScreens } from '../setupScreens'
import { clearOutputStyleCache } from '#cli-services/outputStyles'
import { isDefaultSlowAndCapableModel } from '#core/utils/model'
import { dateToFilename } from '#core/utils/log'
import { assertMinVersion } from '#core/utils/autoUpdater'
import { LEGACY_ENV } from '#core/compat/legacyEnv'
import {
  clearAgentCache,
  setFlagAgentsFromCliJson,
} from '#core/utils/agentLoader'
import {
  setEnabledSettingSourcesFromCli,
  getCurrentProjectConfig,
} from '#config'
import { getClients, getClientsForCliMcpConfig } from '#core/mcp/client'

import {
  renderRepl,
  renderResumeConversationSelector,
} from '../interactive/renderers'

import type { Message } from '#core/query'

type RootCommandOptions = {
  cwd?: string
  debug?: unknown
  verbose?: boolean
  enableArchitect?: boolean
  print?: boolean
  outputFormat?: string
  jsonSchema?: string
  inputFormat?: string
  mcpDebug?: boolean
  dangerouslySkipPermissions?: boolean
  allowDangerouslySkipPermissions?: boolean
  maxThinkingTokens?: number
  maxTurns?: number
  maxBudgetUsd?: number
  includePartialMessages?: boolean
  replayUserMessages?: boolean
  allowedTools?: unknown
  tools?: unknown
  disallowedTools?: unknown
  mcpConfig?: unknown
  systemPrompt?: string
  systemPromptFile?: string
  appendSystemPrompt?: string
  appendSystemPromptFile?: string
  permissionMode?: string
  planModeRequired?: boolean
  permissionPromptTool?: string
  safe?: boolean
  disableSlashCommands?: boolean
  pluginDir?: unknown
  model?: string
  addDir?: unknown
  web?: boolean
  webHost?: string
  webPort?: string
  strictMcpConfig?: boolean
  agents?: string
  settingSources?: string
  resume?: unknown
  continue?: boolean
  forkSession?: boolean
  sessionId?: string
  sessionPersistence: boolean
}

export function createRootAction(args: {
  stdinContent: string
  renderContext: RenderOptions | undefined
  renderContextWithExitOnCtrlC: RenderOptions | undefined
}): (prompt: string | undefined, options: RootCommandOptions) => Promise<void> {
  return async (
    prompt,
    {
      cwd: maybeCwd,
      debug,
      verbose,
      enableArchitect,
      print,
      outputFormat,
      jsonSchema,
      inputFormat,
      mcpDebug,
      dangerouslySkipPermissions,
      allowDangerouslySkipPermissions,
      maxThinkingTokens,
      maxTurns,
      maxBudgetUsd,
      includePartialMessages,
      replayUserMessages,
      allowedTools,
      tools: cliTools,
      disallowedTools,
      mcpConfig,
      systemPrompt: systemPromptOverride,
      systemPromptFile,
      appendSystemPrompt,
      appendSystemPromptFile,
      permissionMode,
      planModeRequired,
      permissionPromptTool,
      safe,
      disableSlashCommands,
      pluginDir,
      model,
      addDir,
      web,
      webHost,
      webPort,
      strictMcpConfig,
      agents,
      settingSources,
      resume,
      continue: continueConversation,
      forkSession,
      sessionId,
      sessionPersistence,
    },
  ) => {
    const cwd = maybeCwd ?? process.cwd()
    const resolvedEntrypoint =
      process.env.KODE_ENTRYPOINT ?? process.env[LEGACY_ENV.codeEntryPoint]
    if (!resolvedEntrypoint) {
      const isNonInteractive =
        print === true ||
        outputFormat === 'stream-json' ||
        inputFormat === 'stream-json' ||
        !process.stdout.isTTY
      process.env.KODE_ENTRYPOINT = isNonInteractive ? 'sdk-cli' : 'cli'
    }

    if (
      !process.env[LEGACY_ENV.codeEntryPoint] &&
      process.env.KODE_ENTRYPOINT
    ) {
      process.env[LEGACY_ENV.codeEntryPoint] = process.env.KODE_ENTRYPOINT
    }

    if (planModeRequired === true) {
      process.env.KODE_PLAN_MODE_REQUIRED = 'true'
      process.env[LEGACY_ENV.codePlanModeRequired] = 'true'
    }
    const normalizedPermissionMode =
      typeof permissionMode === 'string' ? permissionMode.trim() : ''
    const bypassPermissionsRequested =
      normalizedPermissionMode === 'bypassPermissions' ||
      dangerouslySkipPermissions === true

    if (bypassPermissionsRequested) {
      const isRoot =
        process.platform !== 'win32' &&
        typeof process.getuid === 'function' &&
        process.getuid() === 0
      const isSandboxed =
        process.env.IS_SANDBOX === '1' ||
        process.env[LEGACY_ENV.codeBubblewrap] === '1'
      if (isRoot && !isSandboxed) {
        console.error(
          '--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons',
        )
        process.exit(1)
      }
    }

    try {
      setEnabledSettingSourcesFromCli(settingSources)
    } catch (err) {
      process.stderr.write(
        `Error processing --setting-sources: ${err instanceof Error ? err.message : String(err)}\n`,
      )
      process.exit(1)
    }

    const normalizedSystemPromptFile =
      typeof systemPromptFile === 'string' ? systemPromptFile.trim() : ''
    const normalizedAppendSystemPromptFile =
      typeof appendSystemPromptFile === 'string'
        ? appendSystemPromptFile.trim()
        : ''

    if (normalizedSystemPromptFile || normalizedAppendSystemPromptFile) {
      const [{ existsSync }, { readFile }, { resolve }] = await Promise.all([
        import('fs'),
        import('fs/promises'),
        import('path'),
      ])

      if (normalizedSystemPromptFile) {
        if (typeof systemPromptOverride === 'string' && systemPromptOverride) {
          console.error(
            'Error: Cannot use both --system-prompt and --system-prompt-file. Please use only one.',
          )
          process.exit(1)
        }
        const filePath = resolve(cwd, normalizedSystemPromptFile)
        if (!existsSync(filePath)) {
          console.error(`Error: System prompt file not found: ${filePath}`)
          process.exit(1)
        }
        try {
          systemPromptOverride = await readFile(filePath, 'utf8')
        } catch (error) {
          console.error(
            `Error reading system prompt file: ${error instanceof Error ? error.message : String(error)}`,
          )
          process.exit(1)
        }
      }

      if (normalizedAppendSystemPromptFile) {
        if (typeof appendSystemPrompt === 'string' && appendSystemPrompt) {
          console.error(
            'Error: Cannot use both --append-system-prompt and --append-system-prompt-file. Please use only one.',
          )
          process.exit(1)
        }
        const filePath = resolve(cwd, normalizedAppendSystemPromptFile)
        if (!existsSync(filePath)) {
          console.error(
            `Error: Append system prompt file not found: ${filePath}`,
          )
          process.exit(1)
        }
        try {
          appendSystemPrompt = await readFile(filePath, 'utf8')
        } catch (error) {
          console.error(
            `Error reading append system prompt file: ${error instanceof Error ? error.message : String(error)}`,
          )
          process.exit(1)
        }
      }
    }

    setFlagAgentsFromCliJson(agents)
    clearAgentCache()
    clearOutputStyleCache()

    if (web && print) {
      console.error('Error: --web and --print cannot be used together.')
      process.exit(1)
    }

    if (sessionPersistence === false && !print) {
      console.error(
        'Error: --no-session-persistence can only be used with --print mode.',
      )
      process.exit(1)
    }

    if (includePartialMessages && !print) {
      console.error(
        'Error: --include-partial-messages requires --print and --output-format=stream-json.',
      )
      process.exit(1)
    }

    await setup(cwd, safe)

    if (web) {
      const { runWebOnlyMode } = await import('./rootAction/webOnlyMode')
      await runWebOnlyMode({ cwd, webHost, webPort })
      return
    }
    const { postSetupInitialPrompt } = await showSetupScreens(safe, print)

    assertMinVersion()

    {
      const requested =
        Array.isArray(pluginDir) && pluginDir.length > 0 ? pluginDir : []
      const { listEnabledInstalledPluginPackRoots } =
        await import('#cli-services/skillMarketplace')
      const installed = listEnabledInstalledPluginPackRoots()

      const all = [...installed, ...requested].filter(Boolean)
      const deduped = Array.from(new Set(all))

      if (deduped.length > 0) {
        const { configureSessionPlugins } =
          await import('#cli-services/pluginRuntime')
        const { errors } = await configureSessionPlugins({
          pluginDirs: deduped,
        })
        for (const err of errors) {
          console.warn(err)
        }
      }
    }

    const [{ ask }, { getTools }, { getCommands }] = await Promise.all([
      import('#cli-utils/ask'),
      import('#tools'),
      import('#cli-commands'),
    ])
    const commands = await getCommands()

    const { installCliMcpCapabilities } =
      await import('#cli-services/mcpCapabilities')
    // Install capability responders before connecting: the client advertises
    // roots/elicitation/sampling during `initialize`.
    installCliMcpCapabilities({ interactive: print !== true })

    const mcpClientsPromise =
      (Array.isArray(mcpConfig) && mcpConfig.length > 0) ||
      strictMcpConfig === true
        ? getClientsForCliMcpConfig({
            mcpConfig: Array.isArray(mcpConfig) ? mcpConfig : [],
            strictMcpConfig: strictMcpConfig === true,
            projectDir: cwd,
          })
        : getClients()

    const [allTools, mcpClients] = await Promise.all([
      getTools(
        enableArchitect ?? getCurrentProjectConfig().enableArchitectTool,
      ),
      mcpClientsPromise,
    ])
    const tools =
      disableSlashCommands === true
        ? allTools.filter(t => t.name !== 'SlashCommand')
        : allTools
    const inputPrompt = [prompt, args.stdinContent].filter(Boolean).join('\n')
    const effectiveInitialPrompt =
      inputPrompt.trim().length > 0
        ? inputPrompt
        : (postSetupInitialPrompt ?? inputPrompt)

    const {
      loadKodeAgentSessionMessagesForResume,
      findMostRecentKodeAgentSessionId,
    } = await import('#protocol/utils/kodeAgentSessionLoad')
    const { listKodeAgentSessions, resolveResumeSessionIdentifier } =
      await import('#protocol/utils/kodeAgentSessionResume')
    const { isUuid } = await import('#core/utils/uuid')
    const { setSessionId } = await import('#core/utils/sessionId')
    const { getKodeAgentSessionId } =
      await import('#protocol/utils/kodeAgentSessionId')
    const { setKodeAgentSessionForkInfo } =
      await import('#protocol/utils/kodeAgentSessionForkInfo')
    const { randomUUID } = await import('crypto')

    const wantsContinue = Boolean(continueConversation)
    const wantsResume = resume !== undefined
    const wantsFork = Boolean(forkSession)

    if (sessionId && !isUuid(String(sessionId))) {
      console.error(`Error: --session-id must be a valid UUID`)
      process.exit(1)
    }

    if (sessionId && (wantsContinue || wantsResume) && !wantsFork) {
      console.error(
        `Error: --session-id can only be used with --continue or --resume if --fork-session is also specified.`,
      )
      process.exit(1)
    }

    let initialMessages: Message[] | undefined
    let resumedFromSessionId: string | null = null
    let needsResumeSelector = false
    let resumeSelectorInitialQuery: string | undefined

    if (wantsContinue) {
      const latest = findMostRecentKodeAgentSessionId(cwd)
      if (!latest) {
        console.error('No conversation found to continue')
        process.exit(1)
      }
      initialMessages = loadKodeAgentSessionMessagesForResume({
        cwd,
        sessionId: latest,
      })
      resumedFromSessionId = latest
    } else if (wantsResume) {
      if (resume === true) {
        needsResumeSelector = true
        resumeSelectorInitialQuery = ''
      } else {
        const identifier = String(resume)
        if (print && !isUuid(identifier.trim())) {
          console.error(
            'Error: --resume requires a valid session ID when used with --print. Usage: kode -p --resume <session-id>',
          )
          process.exit(1)
        }

        const resolved = resolveResumeSessionIdentifier({ cwd, identifier })
        if (resolved.kind === 'ok') {
          initialMessages = loadKodeAgentSessionMessagesForResume({
            cwd,
            sessionId: resolved.sessionId,
          })
          resumedFromSessionId = resolved.sessionId
        } else if (resolved.kind === 'different_directory') {
          console.error(
            resolved.otherCwd
              ? `Error: That session belongs to a different directory: ${resolved.otherCwd}`
              : `Error: That session belongs to a different directory.`,
          )
          process.exit(1)
        } else if (resolved.kind === 'ambiguous') {
          if (print) {
            console.error(
              `Error: Multiple sessions match "${identifier}": ${resolved.matchingSessionIds.join(
                ', ',
              )}`,
            )
            process.exit(1)
          }
          needsResumeSelector = true
          resumeSelectorInitialQuery = identifier.trim() || undefined
        } else {
          if (print) {
            console.error(
              `No conversation found with session ID: ${identifier.trim()}`,
            )
            process.exit(1)
          }
          needsResumeSelector = true
          resumeSelectorInitialQuery = identifier.trim() || undefined
        }
      }
    }

    if (needsResumeSelector && print) {
      console.error(
        'Error: --resume without a value requires interactive mode (no --print).',
      )
      process.exit(1)
    }

    if (!needsResumeSelector) {
      const effectiveSessionId = (() => {
        if (resumedFromSessionId) {
          if (wantsFork) return sessionId ? String(sessionId) : randomUUID()
          return resumedFromSessionId
        }
        if (sessionId) return String(sessionId)
        return getKodeAgentSessionId()
      })()

      if (resumedFromSessionId && wantsFork) {
        setKodeAgentSessionForkInfo({
          forkedFromSessionId: resumedFromSessionId,
          forkRootSessionId: resumedFromSessionId,
        })
      } else {
        setKodeAgentSessionForkInfo(null)
      }

      setSessionId(effectiveSessionId)
    }

    if (print) {
      await runPrintMode({
        prompt,
        stdinContent: args.stdinContent,
        inputPrompt,
        cwd,
        safe,
        verbose,
        outputFormat,
        inputFormat,
        jsonSchema,
        permissionPromptTool,
        maxThinkingTokens,
        maxTurns,
        maxBudgetUsd,
        includePartialMessages,
        replayUserMessages,
        cliTools,
        tools,
        commands,
        ask,
        initialMessages,
        permissionMode,
        systemPromptOverride,
        appendSystemPrompt,
        disableSlashCommands: disableSlashCommands === true,
        allowedTools,
        disallowedTools,
        dangerouslySkipPermissions,
        allowDangerouslySkipPermissions,
        sessionPersistence,
        model,
        addDir,
        mcpClients,
      })
      return
    }

    // Update check can be slow (npm + network); do it after UI mounts so startup stays snappy.
    const updateInfo = { version: null, commands: null }

    if (needsResumeSelector) {
      const sessions = listKodeAgentSessions({ cwd })
      if (sessions.length === 0) {
        console.error('No conversation found to resume')
        process.exit(1)
      }

      renderResumeConversationSelector(
        {
          cwd,
          commands,
          sessions,
          tools,
          verbose,
          safeMode: safe,
          debug: Boolean(debug),
          disableSlashCommands: disableSlashCommands === true,
          systemPromptOverride,
          appendSystemPrompt,
          mcpClients,
          initialPrompt: effectiveInitialPrompt,
          forkSession: wantsFork,
          forkSessionId: sessionId ? String(sessionId) : null,
          initialQuery: resumeSelectorInitialQuery,
          initialUpdateVersion: updateInfo.version,
          initialUpdateCommands: updateInfo.commands,
        },
        args.renderContextWithExitOnCtrlC,
      )
      return
    }

    const isDefaultModel = await isDefaultSlowAndCapableModel()
    await renderRepl(
      {
        commands,
        debug: Boolean(debug),
        disableSlashCommands: disableSlashCommands === true,
        systemPromptOverride,
        appendSystemPrompt,
        initialPrompt: effectiveInitialPrompt,
        messageLogName: dateToFilename(new Date()),
        shouldShowPromptInput: true,
        verbose,
        tools,
        safeMode: safe,
        mcpClients,
        isDefaultModel,
        initialUpdateVersion: updateInfo.version,
        initialUpdateCommands: updateInfo.commands,
        initialMessages,
      },
      args.renderContext,
    )
  }
}
