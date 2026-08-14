import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  canonicalizeWorkspacePath,
  createWorkspaceLeaseManager,
} from './workspaceLease'

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'workspace-lease-'))
  roots.push(root)
  return root
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for lease.')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('workspace leases', () => {
  test('allows independent managers to hold shared read leases', async () => {
    const root = tempRoot()
    const workspace = join(root, 'workspace')
    const first = createWorkspaceLeaseManager({
      leaseRoot: join(root, 'leases'),
    })
    const second = createWorkspaceLeaseManager({
      leaseRoot: join(root, 'leases'),
    })

    const left = await first.acquire({ workspacePath: workspace, mode: 'read' })
    const right = await second.acquire({
      workspacePath: workspace,
      mode: 'read',
    })

    await right.release()
    await left.release()
  })

  test('holds a writer until every reader releases across managers', async () => {
    const root = tempRoot()
    const workspace = join(root, 'workspace')
    const options = { leaseRoot: join(root, 'leases') }
    const readerManager = createWorkspaceLeaseManager(options)
    const writerManager = createWorkspaceLeaseManager(options)
    const reader = await readerManager.acquire({
      workspacePath: workspace,
      mode: 'read',
    })
    let writerAcquired = false
    const writerPromise = writerManager
      .acquire({ workspacePath: workspace, mode: 'write' })
      .then(lease => {
        writerAcquired = true
        return lease
      })

    await new Promise(resolve => setTimeout(resolve, 40))
    expect(writerAcquired).toBe(false)

    await reader.release()
    await waitFor(() => writerAcquired)
    const writer = await writerPromise
    await writer.release()
  })

  test('cancels a blocked lease request without leaking its local slot', async () => {
    const root = tempRoot()
    const workspace = join(root, 'workspace')
    const options = { leaseRoot: join(root, 'leases') }
    const writerManager = createWorkspaceLeaseManager(options)
    const readerManager = createWorkspaceLeaseManager(options)
    const writer = await writerManager.acquire({
      workspacePath: workspace,
      mode: 'write',
    })
    const controller = new AbortController()
    const blocked = readerManager.acquire({
      workspacePath: workspace,
      mode: 'read',
      signal: controller.signal,
    })

    controller.abort()
    await expect(blocked).rejects.toMatchObject({ name: 'AbortError' })
    await writer.release()

    const reader = await readerManager.acquire({
      workspacePath: workspace,
      mode: 'read',
    })
    await reader.release()
  })

  test('canonicalizes a workspace symlink before choosing a lease key', () => {
    if (process.platform === 'win32') return
    const root = tempRoot()
    const workspace = join(root, 'workspace')
    const alias = join(root, 'workspace-alias')
    mkdirSync(workspace)
    symlinkSync(workspace, alias)

    expect(canonicalizeWorkspacePath(alias)).toBe(
      canonicalizeWorkspacePath(workspace),
    )
  })
})
