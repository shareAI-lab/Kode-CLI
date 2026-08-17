#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

function runOrThrow(cmd, args, options) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `Command failed (${result.status}): ${cmd} ${args.join(' ')}`,
    )
  }
}

const viteBin = join('node_modules', 'vite', 'bin', 'vite.js')

console.log('Building Web UI...')
runOrThrow(process.execPath, [
  viteBin,
  'build',
  '--config',
  'apps/web/vite.config.ts',
])

const srcWebDist = join('apps', 'web', 'dist')
if (!existsSync(join(srcWebDist, 'index.html'))) {
  throw new Error('apps/web/dist/index.html not found after build')
}

const serverStaticDir = join('apps', 'server', 'static')
rmSync(serverStaticDir, { recursive: true, force: true })
mkdirSync(serverStaticDir, { recursive: true })
cpSync(srcWebDist, serverStaticDir, { recursive: true })

console.log('Web UI built')
console.log(`  - ${srcWebDist}`)
console.log(`  - ${serverStaticDir}`)
