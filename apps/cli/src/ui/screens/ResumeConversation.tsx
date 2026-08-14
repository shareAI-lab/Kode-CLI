import React from 'react'
import { render } from 'ink'
import { resolve as resolvePath } from 'node:path'
import { REPL } from './REPL'
import { KeypressProvider } from '#ui-ink/contexts/KeypressContext'
import type { KodeAgentSessionListItem } from '#protocol/utils/kodeAgentSessionResume'
import { logError } from '#core/utils/log'
import type { Tool } from '#core/tooling/Tool'
import type { Command } from '#cli-commands'
import { isDefaultSlowAndCapableModel } from '#core/utils/model'
import type { WrappedClient } from '#core/mcp/client'
import { loadKodeAgentSessionMessagesForResume } from '#protocol/utils/kodeAgentSessionLoad'
import { setSessionId } from '#core/utils/sessionId'
import { setKodeAgentSessionForkInfo } from '#protocol/utils/kodeAgentSessionForkInfo'
import { randomUUID } from 'crypto'
import { dateToFilename } from '#core/utils/log'
import { renderWithTuiStdio } from '#ui-ink/utils/inkRender'
import { ResumeSessionSelector } from '#ui-ink/components/ResumeSessionSelector'
import { switchCwdForResume } from '#cli-utils/switchCwdForResume'
import { clearViewport } from '#cli-utils/terminal'
import { requestCliExit } from '#cli-utils/exit'

type Props = {
  cwd: string
  commands: Command[]
  context: { unmount?: () => void }
  sessions: KodeAgentSessionListItem[]
  initialQuery?: string
  tools: Tool[]
  verbose: boolean | undefined
  safeMode?: boolean
  debug?: boolean
  disableSlashCommands?: boolean
  systemPromptOverride?: string
  appendSystemPrompt?: string
  mcpClients?: WrappedClient[]
  initialPrompt?: string
  forkSession?: boolean
  forkSessionId?: string | null
  initialUpdateVersion?: string | null
  initialUpdateCommands?: string[] | null
}

export function ResumeConversation({
  cwd,
  context,
  commands,
  sessions,
  initialQuery,
  tools,
  verbose,
  safeMode,
  debug,
  disableSlashCommands,
  systemPromptOverride,
  appendSystemPrompt,
  mcpClients,
  initialPrompt,
  forkSession,
  forkSessionId,
  initialUpdateVersion,
  initialUpdateCommands,
}: Props): React.ReactNode {
  async function onSelect(session: KodeAgentSessionListItem) {
    try {
      const resumedFromSessionId = session.sessionId
      const effectiveCwd = session.cwd ?? cwd

      if (effectiveCwd && resolvePath(effectiveCwd) !== resolvePath(cwd)) {
        await switchCwdForResume(effectiveCwd)
      }

      const effectiveSessionId = forkSession
        ? forkSessionId?.trim() || randomUUID()
        : resumedFromSessionId

      setKodeAgentSessionForkInfo(
        forkSession
          ? {
              forkedFromSessionId: resumedFromSessionId,
              forkRootSessionId: resumedFromSessionId,
            }
          : null,
      )
      setSessionId(effectiveSessionId)

      const messages = loadKodeAgentSessionMessagesForResume({
        cwd: effectiveCwd,
        sessionId: resumedFromSessionId,
      })
      const isDefaultModel = await isDefaultSlowAndCapableModel()
      const { getCommands } = await import('#cli-commands')
      const nextCommands = await getCommands()

      // Tear down the selector only once everything is ready. Unmounting
      // first left a blank screen during cwd switch + message load + command
      // construction; the selector now shows "Resuming conversation…" while
      // that async work runs.
      context.unmount?.()
      await clearViewport()

      renderWithTuiStdio(
        render,
        <KeypressProvider
          debugKeystrokeLogging={Boolean(process.env.KODE_DEBUG_KEYSTROKES)}
        >
          <REPL
            commands={nextCommands}
            debug={debug}
            disableSlashCommands={disableSlashCommands}
            systemPromptOverride={systemPromptOverride}
            appendSystemPrompt={appendSystemPrompt}
            initialPrompt={initialPrompt ?? ''}
            messageLogName={dateToFilename(new Date())}
            shouldShowPromptInput={true}
            verbose={verbose}
            tools={tools}
            safeMode={safeMode}
            mcpClients={mcpClients}
            initialMessages={messages}
            isDefaultModel={isDefaultModel}
            initialUpdateVersion={initialUpdateVersion}
            initialUpdateCommands={initialUpdateCommands}
          />
        </KeypressProvider>,
        {
          exitOnCtrlC: false,
        },
      )
    } catch (e) {
      logError(`Failed to load conversation: ${e}`)
      throw e
    }
  }

  return (
    <ResumeSessionSelector
      cwd={cwd}
      sessions={sessions}
      initialQuery={initialQuery}
      onCancel={() => requestCliExit(0)}
      onSelect={onSelect}
    />
  )
}
