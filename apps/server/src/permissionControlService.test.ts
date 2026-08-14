import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import {
  applyToolPermissionContextUpdate,
  createDefaultToolPermissionContext,
} from '@kode/types/toolPermissionContext'

import { PermissionControlService } from './permissionControlService'
import { SessionRegistry } from './sessionRegistry'

describe('PermissionControlService', () => {
  test('updates future decisions without resolving an in-flight approval', () => {
    const cwd = join(process.cwd(), 'permission-control-inflight')
    const registry = new SessionRegistry()
    const session = registry.create(cwd)
    session.toolPermissionContext = createDefaultToolPermissionContext({
      isBypassPermissionsModeAvailable: true,
    })
    let resolved = 0
    session.inflightPermissionRequests.set('permission-1', {
      owner: null,
      resolve: () => {
        resolved += 1
      },
    })
    const audits: Array<{ outcome: string; reason?: string }> = []
    const service = new PermissionControlService(registry, {
      audit: record => audits.push(record),
    })

    const result = service.update({
      cwd,
      sessionId: session.sessionId,
      update: {
        type: 'addRules',
        destination: 'session',
        behavior: 'allow',
        rules: ['Bash(git status)'],
      },
    })

    expect(result).toEqual({
      ok: true,
      value: {
        permission: expect.objectContaining({
          source: 'runtime',
          sessionId: session.sessionId,
          rules: expect.objectContaining({
            allow: expect.objectContaining({
              session: ['Bash(git status)'],
            }),
          }),
        }),
        persisted: false,
        refreshedSessionIds: [session.sessionId],
        inflightApprovalCount: 1,
      },
    })
    expect(session.inflightPermissionRequests.size).toBe(1)
    expect(resolved).toBe(0)
    expect(audits).toEqual([expect.objectContaining({ outcome: 'applied' })])
  })

  test('persists a workspace rule and refreshes every online workspace session', () => {
    const cwd = join(process.cwd(), 'permission-control-refresh')
    const registry = new SessionRegistry()
    const first = registry.create(cwd)
    const second = registry.create(cwd)
    first.toolPermissionContext = createDefaultToolPermissionContext({
      isBypassPermissionsModeAvailable: true,
    })
    second.toolPermissionContext = createDefaultToolPermissionContext({
      isBypassPermissionsModeAvailable: true,
    })
    let disk = createDefaultToolPermissionContext({
      isBypassPermissionsModeAvailable: true,
    })
    let persisted = 0
    const service = new PermissionControlService(registry, {
      loadContext: () => disk,
      persistUpdate: ({ update }) => {
        persisted += 1
        disk = applyToolPermissionContextUpdate(disk, update)
        return { persisted: true }
      },
      audit: () => {},
    })

    const result = service.update({
      cwd,
      update: {
        type: 'addRules',
        destination: 'projectSettings',
        behavior: 'ask',
        rules: ['Bash(git push)'],
      },
    })

    expect(result).toEqual({
      ok: true,
      value: {
        permission: expect.objectContaining({
          source: 'disk',
          rules: expect.objectContaining({
            ask: expect.objectContaining({
              projectSettings: ['Bash(git push)'],
            }),
          }),
        }),
        persisted: true,
        refreshedSessionIds: expect.arrayContaining([
          first.sessionId,
          second.sessionId,
        ]),
        inflightApprovalCount: 0,
      },
    })
    expect(persisted).toBe(1)
    expect(first.toolPermissionContext.alwaysAskRules.projectSettings).toEqual([
      'Bash(git push)',
    ])
    expect(second.toolPermissionContext.alwaysAskRules.projectSettings).toEqual(
      ['Bash(git push)'],
    )
  })

  test('rejects managed-policy mutation and records the rejection', () => {
    const cwd = join(process.cwd(), 'permission-control-policy')
    const registry = new SessionRegistry()
    const session = registry.create(cwd)
    session.toolPermissionContext = createDefaultToolPermissionContext({
      isBypassPermissionsModeAvailable: true,
    })
    const audits: Array<{ outcome: string; reason?: string }> = []
    const service = new PermissionControlService(registry, {
      audit: record => audits.push(record),
    })

    expect(
      service.update({
        cwd,
        sessionId: session.sessionId,
        update: {
          type: 'replaceRules',
          destination: 'policySettings',
          behavior: 'allow',
          rules: ['Bash(*)'],
        },
      }),
    ).toEqual({ ok: false, reason: 'policy_locked' })
    expect(session.toolPermissionContext.alwaysAllowRules.policySettings).toBe(
      undefined,
    )
    expect(audits).toEqual([
      expect.objectContaining({ outcome: 'rejected', reason: 'policy_locked' }),
    ])
  })
})
