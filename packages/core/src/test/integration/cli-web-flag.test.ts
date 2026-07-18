import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('CLI --web flag (opt-in)', () => {
  test('rejects --web with --print (no daemon started)', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'kode-cli-web-'))
    try {
      const res = spawnSync(
        process.execPath,
        ['apps/cli/src/dispatch.ts', '--web', '--print', 'hello'],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            NODE_ENV: 'test',
            CI: '1',
            KODE_CONFIG_DIR: configDir,
          },
          encoding: 'utf8',
        },
      )

      expect(res.status).toBe(1)
      expect(String(res.stderr) + String(res.stdout)).toContain(
        'Error: --web cannot be used with --print or --headless.',
      )
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })
})
