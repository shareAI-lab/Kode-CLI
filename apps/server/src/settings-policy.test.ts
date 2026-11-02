import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsFileError } from '@kode/config'
import { createDefaultToolPermissionContext } from '@kode/core/types/toolPermissionContext'
import {
  getCwd,
  getOriginalCwd,
  setCwd,
  setOriginalCwd,
} from '@kode/core/utils/state'
import { createRoutes } from './routes'
import { createWebSocketHandlers } from './ws/connection'
import type { DaemonSession } from './ws/types'
import {
  handleSessionLoad,
  handleSessionNew,
} from './acp/agent/handlers/sessions'
import { persistAcpSessionToDisk } from './acp/agent/sessionStore'
import type { SessionState } from './acp/agent/types'
import type { JsonRpcPeer } from './acp/jsonrpc'

describe('server policy initialization failures', () => {
  const originalConfigDir = process.env.KODE_CONFIG_DIR
  const originalCwd = getCwd()
  const originalWorkingDir = getOriginalCwd()
  let root: string
  let policyPath: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kode-server-policy-'))
    mkdirSync(join(root, '.kode'))
    mkdirSync(join(root, 'config'))
    process.env.KODE_CONFIG_DIR = join(root, 'config')
    writeFileSync(join(root, 'config', 'settings.json'), '{}')
    policyPath = join(root, '.kode', 'settings.json')
    writeFileSync(policyPath, '{"permissions":')
  })

  afterEach(async () => {
    await setCwd(originalCwd)
    setOriginalCwd(originalWorkingDir)
    if (originalConfigDir === undefined) delete process.env.KODE_CONFIG_DIR
    else process.env.KODE_CONFIG_DIR = originalConfigDir
    rmSync(root, { recursive: true, force: true })
  })

  test('WebSocket upgrade reports a policy error and creates no session; repair allows a new session', async () => {
    const sessions = new Map<string, DaemonSession>()
    let upgraded = false
    const routes = createRoutes({
      webuiRoot: null,
      checkToken: () => true,
      listWorkspaces: async () => ({
        currentId: root,
        workspaces: [
          {
            id: root,
            path: root,
            title: 'fixture',
            branch: null,
            isCurrent: true,
          },
        ],
      }),
      sessions,
      cwd: root,
      echo: true,
      commands: [],
      tools: [],
      toolNames: [],
      slashCommands: [],
    })
    const server = {
      upgrade: () => {
        upgraded = true
        return true
      },
    }
    const response = await routes.fetch(
      new Request('http://localhost/ws'),
      server,
    )
    expect(response?.status).toBe(500)
    expect(await response?.text()).toContain('Cannot load settings')
    expect(upgraded).toBe(false)
    expect(sessions.size).toBe(0)

    writeFileSync(policyPath, '{"permissions":{"deny":["Write(.env)"]}}')
    expect(
      await routes.fetch(new Request('http://localhost/ws'), server),
    ).toBeUndefined()
    expect(upgraded).toBe(true)
    expect(
      [...sessions.values()][0]?.toolPermissionContext.alwaysDenyRules
        .projectSettings,
    ).toEqual(['Write(.env)'])
  })

  test('failed new-session closes the socket and cannot reuse its old policy through queued frames', async () => {
    const controller = new AbortController()
    const session: DaemonSession = {
      sessionId: 'old-session',
      cwd: root,
      ws: null,
      messages: [],
      readFileTimestamps: {},
      responseState: {},
      toolPermissionContext: createDefaultToolPermissionContext(),
      activeAbortController: controller,
      inflightPermissionRequests: new Map(),
    }
    const sessions = new Map([[session.sessionId, session]])
    const messages: string[] = []
    let closeCode = 0
    const ws = {
      data: { session },
      send: (message: string) => messages.push(message),
      close: (code: number) => {
        closeCode = code
      },
    } as unknown as Parameters<
      ReturnType<typeof createWebSocketHandlers>['message']
    >[0]
    const handlers = createWebSocketHandlers({
      sessions,
      tools: [],
      commands: [],
      toolNames: [],
      slashCommands: [],
      echo: true,
    })
    await handlers.message(ws, Buffer.from('{"type":"new_session"}'))
    expect(controller.signal.aborted).toBe(true)
    expect(sessions.size).toBe(0)
    expect(closeCode).toBe(1011)
    expect(messages.join('\n')).toContain('Cannot load settings')
    writeFileSync(policyPath, '{}')
    await handlers.message(ws, Buffer.from('{"type":"new_session"}'))
    expect(sessions.size).toBe(0)
  })

  test('ACP session/new and session/load reject before connecting dependencies or registering a session', async () => {
    const sessions = new Map<string, SessionState>()
    // No peer operations should occur until policy initialization succeeds.
    const peer = {} as JsonRpcPeer
    await expect(
      handleSessionNew({
        peer,
        sessions,
        params: { cwd: root, mcpServers: [] },
      }),
    ).rejects.toBeInstanceOf(SettingsFileError)
    expect(sessions.size).toBe(0)

    persistAcpSessionToDisk({
      sessionId: 'saved-session',
      cwd: root,
      mcpServers: [],
      messages: [],
      toolPermissionContext: createDefaultToolPermissionContext(),
      readFileTimestamps: {},
      responseState: {},
      currentModeId: 'yolo',
    } as unknown as SessionState)
    await expect(
      handleSessionLoad({
        peer,
        sessions,
        params: { cwd: root, sessionId: 'saved-session', mcpServers: [] },
      }),
    ).rejects.toBeInstanceOf(SettingsFileError)
    expect(sessions.size).toBe(0)
  })
})
