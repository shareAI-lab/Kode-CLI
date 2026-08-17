import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { startKodeDaemon } from '#daemon/server'

function ensureWebuiBuilt(): void {
  const index = join(process.cwd(), 'apps', 'server', 'static', 'index.html')
  if (existsSync(index)) return

  const res = spawnSync(process.execPath, ['run', 'build:web'], {
    encoding: 'utf8',
    timeout: 5 * 60 * 1000,
    env: { ...process.env },
  })
  if (res.status !== 0) {
    throw new Error(`vite build failed: ${res.stdout}\n${res.stderr}`)
  }
}

describe('daemon WebUI autodetect', () => {
  test('serves WebUI without explicit webuiDir', async () => {
    ensureWebuiBuilt()

    const daemon = await startKodeDaemon({
      cwd: process.cwd(),
      port: 0,
      echo: true,
    })

    try {
      const indexRes = await fetch(`http://${daemon.host}:${daemon.port}/`)
      expect(indexRes.status).toBe(200)
      expect(String(indexRes.headers.get('content-type') ?? '')).toContain(
        'text/html',
      )
      const html = await indexRes.text()
      expect(html).toContain('Kode WebUI')

      const scriptMatch = html.match(/<script[^>]+src=\"([^\"]+)\"/i)
      expect(scriptMatch).toBeTruthy()
      const scriptSrc = String(scriptMatch?.[1] ?? '')

      const cssMatch = html.match(
        /<link[^>]+rel=\"stylesheet\"[^>]+href=\"([^\"]+)\"/i,
      )
      expect(cssMatch).toBeTruthy()
      const cssHref = String(cssMatch?.[1] ?? '')

      const jsRes = await fetch(
        `http://${daemon.host}:${daemon.port}${scriptSrc}`,
      )
      expect(jsRes.status).toBe(200)
      expect(String(jsRes.headers.get('content-type') ?? '')).toContain(
        'text/javascript',
      )

      const cssRes = await fetch(
        `http://${daemon.host}:${daemon.port}${cssHref}`,
      )
      expect(cssRes.status).toBe(200)
      expect(String(cssRes.headers.get('content-type') ?? '')).toContain(
        'text/css',
      )
    } finally {
      daemon.stop()
    }
  }, 20_000)
})
