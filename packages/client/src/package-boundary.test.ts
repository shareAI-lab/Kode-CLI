import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')

function workspaceDeps(relativePackageJson: string): string[] {
  const raw = JSON.parse(
    readFileSync(join(repoRoot, relativePackageJson), 'utf8'),
  ) as {
    dependencies?: Record<string, string>
  }
  return Object.keys(raw.dependencies ?? {}).filter(name =>
    name.startsWith('@kode/'),
  )
}

/**
 * Phase 2 FE/BE/core separation: web and client must stay free of core/engine
 * hosts. Server may load core/engine but must not depend on the web app.
 */
describe('package boundary contracts', () => {
  test('apps/web depends only on client + protocol', () => {
    expect(workspaceDeps('apps/web/package.json').sort()).toEqual([
      '@kode/client',
      '@kode/protocol',
    ])
  })

  test('packages/client depends only on protocol', () => {
    expect(workspaceDeps('packages/client/package.json')).toEqual([
      '@kode/protocol',
    ])
  })

  test('apps/server loads core/engine hosts but not web', () => {
    const deps = new Set(workspaceDeps('apps/server/package.json'))
    expect(deps.has('@kode/core')).toBe(true)
    expect(deps.has('@kode/engine')).toBe(true)
    expect(deps.has('@kode/protocol')).toBe(true)
    expect(deps.has('@kode/web')).toBe(false)
  })

  test('packages/core package.json does not depend on engine or ai', () => {
    const deps = new Set(workspaceDeps('packages/core/package.json'))
    expect(deps.has('@kode/engine')).toBe(false)
    expect(deps.has('@kode/ai')).toBe(false)
  })
})
