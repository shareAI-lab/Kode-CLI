import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket as WsClient } from 'ws'

import { startKodeDaemon } from '#daemon/server'

type AnyEvent = any

function getWsMessageData(ev: unknown): unknown {
  if (!ev) return undefined
  if (typeof ev !== 'object' || Array.isArray(ev)) return ev
  const record = ev as Record<string, unknown>
  if ('data' in record) return record.data
  return ev
}

function decodeWsMessage(ev: unknown): string {
  const raw = getWsMessageData(ev)
  if (typeof raw === 'string') return raw
  if (raw instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(raw))
  }
  if (ArrayBuffer.isView(raw)) {
    const view = raw as ArrayBufferView
    return new TextDecoder().decode(
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
    )
  }
  return String(raw ?? '')
}

function waitForEvent(
  events: AnyEvent[],
  predicate: (e: AnyEvent) => boolean,
  timeoutMs: number,
): Promise<AnyEvent> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tick = () => {
      const found = events.find(predicate)
      if (found) return resolve(found)
      if (Date.now() > deadline) return reject(new Error('timeout'))
      setTimeout(tick, 10)
    }
    tick()
  })
}

function hasGit(): boolean {
  const res = spawnSync('git', ['--version'], { encoding: 'utf8' })
  return res.status === 0 && !res.error
}

function sanitizeWorkspaceKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-')
}

function restoreOptionalEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name]
    return
  }
  process.env[name] = value
}

describe('daemon git endpoints (WS)', () => {
  const maybeTest = hasGit() ? test : test.skip

  maybeTest(
    'git checkout is blocked when peers present',
    async () => {
      const previousKodeConfigDir = process.env.KODE_CONFIG_DIR
      const repoDir = mkdtempSync(join(tmpdir(), 'kode-daemon-git-guard-'))
      const kodeRoot = mkdtempSync(join(tmpdir(), 'kode-daemon-git-root-'))

      try {
        process.env.KODE_CONFIG_DIR = kodeRoot

        const run = (args: string[]) => {
          const res = spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' })
          if (res.status !== 0) {
            throw new Error(
              `git ${args.join(' ')} failed: ${res.stdout}\n${res.stderr}`,
            )
          }
        }

        run(['init'])
        run(['config', 'user.email', 'test@example.com'])
        run(['config', 'user.name', 'Test User'])

        writeFileSync(join(repoDir, 'a.txt'), 'hello\n', 'utf8')
        run(['add', '.'])
        run(['commit', '-m', 'init'])
        run(['branch', 'test-branch'])

        const topLevelRes = spawnSync('git', ['rev-parse', '--show-toplevel'], {
          cwd: repoDir,
          encoding: 'utf8',
        })
        const topLevel =
          topLevelRes.status === 0
            ? String(topLevelRes.stdout ?? '').trim()
            : ''
        const workspaceKey = sanitizeWorkspaceKey(topLevel || repoDir)
        const agentsDir = join(kodeRoot, 'workspaces', workspaceKey, 'agents')
        mkdirSync(agentsDir, { recursive: true })
        writeFileSync(
          join(agentsDir, 'agent-peer-99999.json'),
          JSON.stringify(
            {
              pid: 99999,
              workspaceKey,
              lastSeenAt: Date.now(),
            },
            null,
            2,
          ),
          'utf8',
        )

        const daemon = await startKodeDaemon({
          cwd: repoDir,
          port: 0,
          echo: true,
        })

        try {
          const ws = new WsClient(
            `ws://${daemon.host}:${daemon.port}/ws?token=${encodeURIComponent(
              daemon.token,
            )}`,
          )

          const events: AnyEvent[] = []
          ws.on('message', data => {
            try {
              const msg = JSON.parse(decodeWsMessage(data))
              events.push(msg)
              if (
                msg?.type === 'permission_request' &&
                typeof msg.request_id === 'string'
              ) {
                ws.send(
                  JSON.stringify({
                    type: 'permission_response',
                    request_id: msg.request_id,
                    decision: 'allow_once',
                  }),
                )
              }
            } catch {
              /* no-op */
            }
          })

          await new Promise<void>((resolve, reject) => {
            ws.once('open', () => resolve())
            ws.once('error', err =>
              reject(
                err instanceof Error
                  ? err
                  : new Error(err ? String(err) : 'ws error'),
              ),
            )
          })

          await waitForEvent(
            events,
            e => e && e.type === 'system' && e.subtype === 'init',
            5_000,
          )

          ws.send(JSON.stringify({ type: 'git_status' }))
          const before = await waitForEvent(
            events,
            e => e && e.type === 'git_status_result' && e.isRepo === true,
            10_000,
          )
          const beforeBranch = before.branch

          ws.send(
            JSON.stringify({ type: 'git_checkout', branch: 'test-branch' }),
          )
          const checkout = await waitForEvent(
            events,
            e => e && e.type === 'git_checkout_result',
            10_000,
          )
          expect(checkout.ok).toBe(false)
          expect(String(checkout.message || '')).toContain('Blocked')

          ws.send(JSON.stringify({ type: 'git_status' }))
          const after = await waitForEvent(
            events,
            e =>
              e &&
              e.type === 'git_status_result' &&
              e.isRepo === true &&
              e.branch === beforeBranch,
            10_000,
          )
          expect(after.branch).toBe(beforeBranch)

          try {
            ws.close()
          } catch {
            /* no-op */
          }
        } finally {
          daemon.stop()
        }
      } finally {
        restoreOptionalEnv('KODE_CONFIG_DIR', previousKodeConfigDir)
        rmSync(kodeRoot, { recursive: true, force: true })
        rmSync(repoDir, { recursive: true, force: true })
      }
    },
    30_000,
  )

  maybeTest(
    'git status/diff/stage/commit works (permission-gated)',
    async () => {
      const repoDir = mkdtempSync(join(tmpdir(), 'kode-daemon-git-'))
      try {
        const run = (args: string[]) => {
          const res = spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' })
          if (res.status !== 0) {
            throw new Error(
              `git ${args.join(' ')} failed: ${res.stdout}\n${res.stderr}`,
            )
          }
        }

        run(['init'])
        run(['config', 'user.email', 'test@example.com'])
        run(['config', 'user.name', 'Test User'])

        writeFileSync(join(repoDir, 'a.txt'), 'hello\n', 'utf8')
        run(['add', '.'])
        run(['commit', '-m', 'init'])

        run(['branch', 'test-branch'])

        const daemon = await startKodeDaemon({
          cwd: repoDir,
          port: 0,
          echo: true,
        })

        try {
          const ws = new WsClient(
            `ws://${daemon.host}:${daemon.port}/ws?token=${encodeURIComponent(daemon.token)}&fresh_session=1`,
          )

          const events: AnyEvent[] = []
          ws.on('message', data => {
            try {
              const msg = JSON.parse(decodeWsMessage(data))
              events.push(msg)
              if (
                msg?.type === 'permission_request' &&
                typeof msg.request_id === 'string'
              ) {
                ws.send(
                  JSON.stringify({
                    type: 'permission_response',
                    request_id: msg.request_id,
                    decision: 'allow_once',
                  }),
                )
              }
            } catch {
              /* no-op */
            }
          })

          await new Promise<void>((resolve, reject) => {
            ws.once('open', () => resolve())
            ws.once('error', err =>
              reject(
                err instanceof Error
                  ? err
                  : new Error(err ? String(err) : 'ws error'),
              ),
            )
          })

          const init = await waitForEvent(
            events,
            e => e && e.type === 'system' && e.subtype === 'init',
            5_000,
          )
          expect(typeof init.session_id).toBe('string')

          const permissionResponse = await fetch(
            `http://${daemon.host}:${daemon.port}/api/permissions?token=${encodeURIComponent(daemon.token)}&workspace=${encodeURIComponent(init.cwd)}`,
            {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                sessionId: init.session_id,
                update: {
                  type: 'setMode',
                  mode: 'acceptEdits',
                  destination: 'session',
                },
              }),
            },
          )
          expect(permissionResponse.status).toBe(200)

          ws.send(JSON.stringify({ type: 'git_branches' }))
          const branches = await waitForEvent(
            events,
            e => e && e.type === 'git_branches_result',
            10_000,
          )
          expect(Array.isArray(branches.branches)).toBe(true)
          expect(branches.branches.includes('test-branch')).toBe(true)

          ws.send(
            JSON.stringify({ type: 'git_checkout', branch: 'test-branch' }),
          )
          const checkout = await waitForEvent(
            events,
            e => e && e.type === 'git_checkout_result',
            10_000,
          )
          expect(checkout.ok).toBe(true)

          ws.send(JSON.stringify({ type: 'git_status' }))
          const onBranch = await waitForEvent(
            events,
            e =>
              e && e.type === 'git_status_result' && e.branch === 'test-branch',
            10_000,
          )
          expect(onBranch.isRepo).toBe(true)

          // Reset event buffer so subsequent assertions don't match earlier results.
          events.length = 0

          writeFileSync(join(repoDir, 'a.txt'), 'hello\nworld\n', 'utf8')

          ws.send(JSON.stringify({ type: 'git_status' }))
          const status1 = await waitForEvent(
            events,
            e =>
              e &&
              e.type === 'git_status_result' &&
              Array.isArray(e.entries) &&
              e.entries.some((x: any) => x?.path === 'a.txt'),
            10_000,
          )
          expect(status1.isRepo).toBe(true)
          expect(Array.isArray(status1.entries)).toBe(true)
          expect(status1.entries.some((x: any) => x?.path === 'a.txt')).toBe(
            true,
          )

          ws.send(
            JSON.stringify({ type: 'git_diff', path: 'a.txt', staged: false }),
          )
          const diff1 = await waitForEvent(
            events,
            e => e && e.type === 'git_diff_result',
            10_000,
          )
          expect(String(diff1.diff || '')).toContain('+world')

          ws.send(JSON.stringify({ type: 'git_stage', path: 'a.txt' }))
          const stage = await waitForEvent(
            events,
            e => e && e.type === 'git_action_result' && e.action === 'stage',
            10_000,
          )
          expect(stage.ok).toBe(true)

          ws.send(
            JSON.stringify({
              type: 'git_commit',
              message: 'test: commit from webui',
            }),
          )
          const commit = await waitForEvent(
            events,
            e => e && e.type === 'git_commit_result',
            20_000,
          )
          expect(commit.ok).toBe(true)

          ws.send(JSON.stringify({ type: 'git_status' }))
          const status2 = await waitForEvent(
            events,
            e =>
              e &&
              e.type === 'git_status_result' &&
              Array.isArray(e.entries) &&
              e.entries.length === 0,
            10_000,
          )
          expect(status2.isRepo).toBe(true)
          expect(Array.isArray(status2.entries)).toBe(true)
          expect(status2.entries.length).toBe(0)

          try {
            ws.close()
          } catch {
            /* no-op */
          }
        } finally {
          daemon.stop()
        }
      } finally {
        rmSync(repoDir, { recursive: true, force: true })
      }
    },
    30_000,
  )
})
