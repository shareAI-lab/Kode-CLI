import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { setCwd, setOriginalCwd } from '@kode/core/utils/state'
import { grantReadPermissionForOriginalDir } from '@kode/core/utils/permissions/filesystem'
import { getClients } from '@kode/mcp/client'
import { probeDurableRunProcess, reconcileDurableRuns } from '@kode/runs'
import { GoalService, isBackgroundKeepAliveGoal } from '@kode/goals'
import { getTools } from '@kode/tools'

import { serveNode } from './server/serveNode'
import { createTokenChecker } from './server/auth'
import { detectWebuiDir } from './server/webui'
import { createWorkspaceLister } from './handlers/workspaces.handler'
import { handleChatPrompt } from './handlers/chat.handler'
import { PersistentSessionService } from './persistentSessionService'
import { createRoutes } from './routes'
import { createWebSocketHandlers } from './ws/connection'
import type { DaemonSession } from './ws/types'
import { broadcastSessionJson } from './ws/sessionBroadcaster'
import { SessionRegistry } from './sessionRegistry'
import { processDaemonRuntimeCoordinator } from './turnGate'
import { GoalScheduleRunner } from './automation/goalScheduleRunner'
import { BackgroundLoopSessions } from './automation/backgroundLoopSessions'

type WebSocketData = {
  session: DaemonSession
  replayHistory: boolean
  correlatedEvents: boolean
  afterSequence: number | null
}

export type KodeDaemon = {
  url: string
  host: string
  port: number
  token: string
  stop: () => void
}

export async function startKodeDaemon(args: {
  host?: string
  port?: number
  cwd: string
  token?: string
  webuiDir?: string
  /**
   * Test-only mode: never calls an LLM, replies by echoing user prompt.
   */
  echo?: boolean
  /** Test-only delay used to keep an echo turn in flight deterministically. */
  echoDelayMs?: number
}): Promise<KodeDaemon> {
  const host = args.host ?? '127.0.0.1'
  const port = args.port ?? 0
  // The token is a bearer credential that may protect a daemon explicitly
  // bound beyond loopback. Keep the complete UUID entropy instead of a short
  // display-oriented prefix.
  const token = args.token ?? crypto.randomUUID().replace(/-/g, '')
  const cwd = resolve(args.cwd)
  const echo = args.echo === true || process.env.KODE_DAEMON_ECHO === '1'
  const echoDelayMs = Math.max(0, args.echoDelayMs ?? 0)

  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const webuiDir =
    typeof args.webuiDir === 'string'
      ? args.webuiDir
      : detectWebuiDir(moduleDir)
  const webuiRoot = webuiDir ? resolve(webuiDir) : null

  const [tools, mcpClients] =
    await processDaemonRuntimeCoordinator.runStartupExclusive(async () => {
      setOriginalCwd(cwd)
      await setCwd(cwd)
      grantReadPermissionForOriginalDir()
      try {
        reconcileDurableRuns({ probeProcess: probeDurableRunProcess })
      } catch {
        // A stale journal must not prevent daemon startup.
      }
      return await Promise.all([getTools(), getClients()])
    })
  const toolNames = tools.map(t => t.name)
  const commands: unknown[] = []
  const slashCommands: string[] = []

  const sessions = new Map<string, DaemonSession>()
  const sessionRegistry = new SessionRegistry(sessions)
  const sessionService = new PersistentSessionService(sessionRegistry)
  const goalService = new GoalService()
  const backgroundLoopSessions = new BackgroundLoopSessions({
    service: goalService,
    sessionRegistry,
  })
  const turnGate = processDaemonRuntimeCoordinator
  const checkToken = createTokenChecker({ token })
  const workspaces = createWorkspaceLister({ cwd })

  const routes = createRoutes({
    webuiRoot,
    checkToken,
    listWorkspaces: workspaces.listWorkspaces,
    sessionRegistry,
    sessionService,
    turnGate,
    cwd,
    echo,
    echoDelayMs,
    commands,
    tools,
    toolNames,
    slashCommands,
    mcpClients,
  })

  const websocket = createWebSocketHandlers({
    sessionRegistry,
    sessionService,
    turnGate,
    toolNames,
    slashCommands,
    commands,
    tools,
    echo,
    echoDelayMs,
    mcpClients,
  })

  const isDetachedBackgroundSession = (session: DaemonSession): boolean =>
    session.clients.size === 0 && backgroundLoopSessions.has(session)

  // Ordinary schedules keep the existing connected-session boundary. A loop
  // explicitly marked backgroundKeepAlive additionally restores its durable
  // session after terminal/daemon restart, but remains on the same tool and
  // permission path as a foreground chat turn.
  const goalScheduleRunner = new GoalScheduleRunner({
    listSessions: () => {
      const scheduledSessions = new Map(sessions)
      for (const session of backgroundLoopSessions.list()) {
        scheduledSessions.set(session.sessionId, session)
      }
      return scheduledSessions.values()
    },
    canDispatch: session =>
      (session.clients.size > 0 || isDetachedBackgroundSession(session)) &&
      session.turnInFlight === false &&
      turnGate.isIdle(),
    isBackgroundSession: isDetachedBackgroundSession,
    dispatch: async ({ session, schedule }) => {
      const lease = turnGate.tryAcquire(session)
      if (!lease) throw new Error('Daemon runtime is busy.')
      try {
        await handleChatPrompt({
          wsSend: payload => broadcastSessionJson(session, payload),
          session,
          prompt: schedule.prompt,
          echo,
          echoDelayMs,
          commands,
          tools,
          toolNames,
          slashCommands,
          mcpClients,
          shouldAvoidPermissionPrompts:
            session.clients.size === 0 &&
            isBackgroundKeepAliveGoal(
              goalService.getGoal(schedule.goalId) ?? {
                schedule,
                metadata: undefined,
              },
            ),
        })
      } finally {
        lease.release()
        sessionRegistry.evictIdleSessions()
      }
    },
  })

  const server = await serveNode<WebSocketData>({
    hostname: host,
    port,
    fetch: routes.fetch,
    websocket,
  })

  goalScheduleRunner.start()

  const displayHost = host === '127.0.0.1' ? 'localhost' : host

  let stopped = false
  return {
    url: `http://${displayHost}:${server.port}?token=${encodeURIComponent(token)}`,
    host,
    port: server.port,
    token,
    stop: () => {
      if (stopped) return
      stopped = true
      goalScheduleRunner.stop()
      try {
        sessionRegistry.cancelActiveWork('Daemon stopped')
      } catch {
        // Continue shutdown even if active work cannot be cancelled cleanly.
      }
      try {
        server.stop(true)
      } catch {
        // stop() is idempotent from the caller's perspective.
      }
    },
  }
}
