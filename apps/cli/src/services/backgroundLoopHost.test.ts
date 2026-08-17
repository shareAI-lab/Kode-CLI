import { describe, expect, test } from 'bun:test'

import { ensureBackgroundLoopHost } from './backgroundLoopHost'

describe('background loop host', () => {
  test('reuses a compatible workspace daemon', async () => {
    const calls: unknown[] = []
    const result = await ensureBackgroundLoopHost({
      cwd: '/workspace',
      versionSignature: 'test:runtime',
      supervisor: {
        start: async args => {
          calls.push(args)
          return {
            state: 'reused',
            entry: {
              schemaVersion: 1,
              workspaceKey: '/workspace',
              workspacePath: '/workspace',
              pid: 1234,
              url: 'http://127.0.0.1:4444/',
              token: 'token',
              versionSignature: 'test:runtime',
              startedAt: 1,
              updatedAt: 1,
            },
          }
        },
      },
    })

    expect(result.state).toBe('reused')
    expect(calls).toEqual([
      { workspacePath: '/workspace', versionSignature: 'test:runtime' },
    ])
  })

  test('does not replace a different daemon version implicitly', async () => {
    await expect(
      ensureBackgroundLoopHost({
        cwd: '/workspace',
        supervisor: {
          start: async () => ({
            state: 'version_mismatch',
            requestedVersionSignature: 'new',
            entry: {
              schemaVersion: 1,
              workspaceKey: '/workspace',
              workspacePath: '/workspace',
              pid: 1234,
              url: 'http://127.0.0.1:4444/',
              token: 'token',
              versionSignature: 'old',
              startedAt: 1,
              updatedAt: 1,
            },
          }),
        },
      }),
    ).rejects.toThrow('stop it explicitly')
  })
})
