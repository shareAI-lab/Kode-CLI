import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  __isMcpRootsCwdWatcherActiveForTests,
  __resetMcpRootsForTests,
  __setMcpRootsTrustOverrideForTests,
  createMcpRootsForCwd,
  getMcpClientCapabilities,
  notifyMcpRootsListChanged,
  registerMcpClientRequestHandlers,
  unregisterMcpClientRequestHandlers,
} from '#core/mcp/client/roots'
import {
  __resetCwdChangedListenersForTests,
  getCwd,
  setCwd,
} from '#core/utils/state'

describe('MCP client roots', () => {
  afterEach(() => {
    __resetMcpRootsForTests()
    __resetCwdChangedListenersForTests()
  })

  test('creates file URI roots from the current workspace path', () => {
    const workspacePath = join(tmpdir(), 'kode-mcp-root', 'project')
    const root = createMcpRootsForCwd(workspacePath)[0]
    expect(root?.uri).toBe(pathToFileURL(workspacePath).toString())
    expect(root?.name).toBe('project')
  })

  test('declares roots capability only for trusted workspaces', () => {
    __setMcpRootsTrustOverrideForTests(false)
    expect(getMcpClientCapabilities()).toEqual({})

    __setMcpRootsTrustOverrideForTests(true)
    expect(getMcpClientCapabilities()).toEqual({
      roots: { listChanged: true },
    })
  })

  test('registers roots/list handler when roots are exposed', async () => {
    const originalCwd = getCwd()
    const projectDir = mkdtempSync(join(tmpdir(), 'kode-mcp-roots-'))
    let handler: (() => Promise<unknown>) | null = null

    try {
      await setCwd(projectDir)
      __setMcpRootsTrustOverrideForTests(true)

      registerMcpClientRequestHandlers({
        setRequestHandler: (_schema: unknown, fn: () => Promise<unknown>) => {
          handler = fn
        },
      } as any)

      expect(handler).not.toBeNull()
      expect(await handler?.()).toEqual({
        roots: createMcpRootsForCwd(projectDir),
      })
    } finally {
      await setCwd(originalCwd)
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  test('notifies connected roots clients when cwd changes', async () => {
    const originalCwd = getCwd()
    const projectDir = mkdtempSync(join(tmpdir(), 'kode-mcp-roots-change-'))
    const notifications: string[] = []

    try {
      __setMcpRootsTrustOverrideForTests(true)

      registerMcpClientRequestHandlers({
        setRequestHandler: () => {},
        sendRootsListChanged: async () => {
          notifications.push('roots/list_changed')
        },
      } as any)

      await setCwd(projectDir)
      expect(notifications).toEqual(['roots/list_changed'])
    } finally {
      __resetMcpRootsForTests()
      await setCwd(originalCwd)
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  test('does not notify unregistered roots clients after cwd changes', async () => {
    const originalCwd = getCwd()
    const projectDir = mkdtempSync(join(tmpdir(), 'kode-mcp-roots-unregister-'))
    const notifications: string[] = []
    const client = {
      setRequestHandler: () => {},
      sendRootsListChanged: async () => {
        notifications.push('roots/list_changed')
      },
    } as any

    try {
      __setMcpRootsTrustOverrideForTests(true)
      registerMcpClientRequestHandlers(client)
      expect(__isMcpRootsCwdWatcherActiveForTests()).toBe(true)
      unregisterMcpClientRequestHandlers(client)
      expect(__isMcpRootsCwdWatcherActiveForTests()).toBe(false)

      await setCwd(projectDir)
      expect(notifications).toEqual([])
    } finally {
      __resetMcpRootsForTests()
      await setCwd(originalCwd)
      rmSync(projectDir, { recursive: true, force: true })
    }
  })

  test('removes roots/list handler only for registered roots clients', () => {
    const removedMethods: string[] = []
    const client = {
      setRequestHandler: () => {},
      removeRequestHandler: (method: string) => {
        removedMethods.push(method)
      },
      sendRootsListChanged: async () => {},
    } as any

    __setMcpRootsTrustOverrideForTests(false)
    registerMcpClientRequestHandlers(client)
    unregisterMcpClientRequestHandlers(client)
    expect(removedMethods).toEqual([])

    __setMcpRootsTrustOverrideForTests(true)
    registerMcpClientRequestHandlers(client)
    unregisterMcpClientRequestHandlers(client)
    expect(removedMethods).toEqual(['roots/list'])
  })

  test('stops watching cwd after a roots notification failure removes the last client', async () => {
    __setMcpRootsTrustOverrideForTests(true)

    registerMcpClientRequestHandlers({
      setRequestHandler: () => {},
      sendRootsListChanged: async () => {
        throw new Error('closed')
      },
    } as any)

    expect(__isMcpRootsCwdWatcherActiveForTests()).toBe(true)
    notifyMcpRootsListChanged()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(__isMcpRootsCwdWatcherActiveForTests()).toBe(false)
  })
})
