import { gzipSync } from 'node:zlib'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)))
const WEB_DIST = join(rootDir, 'apps', 'web', 'dist', 'assets')
const WEB_INDEX = join(rootDir, 'apps', 'web', 'dist', 'index.html')

function assetGzipSize(file) {
  return gzipSync(readFileSync(join(WEB_DIST, file))).length
}

function assetPathFromTag(tag, attribute) {
  const match = new RegExp(
    `${attribute}=["']\\/assets\\/([^"']+\\.js)["']`,
  ).exec(tag)
  return match?.[1] ?? null
}

function initialWebAssets() {
  const html = readFileSync(WEB_INDEX, 'utf8')
  const assets = new Set()
  for (const match of html.matchAll(/<(script|link)\b[^>]*>/g)) {
    const tag = match[0]
    const isEntryScript =
      match[1] === 'script' && /type=["']module["']/.test(tag)
    const isModulePreload =
      match[1] === 'link' && /rel=["']modulepreload["']/.test(tag)
    if (!isEntryScript && !isModulePreload) continue
    const asset = assetPathFromTag(tag, isEntryScript ? 'src' : 'href')
    if (asset) assets.add(asset)
  }
  if (assets.size === 0) {
    throw new Error(
      'web entry/modulepreload assets not found; run build:web first',
    )
  }
  return assets
}

function staticImports(file) {
  const source = readFileSync(join(WEB_DIST, file), 'utf8')
  const imports = new Set()
  for (const match of source.matchAll(
    /(?:\bfrom|\bimport)\s*["']\.\/([^"']+\.js)["']/g,
  )) {
    imports.add(match[1])
  }
  return imports
}

function addStaticDependencies(assets, file) {
  if (assets.has(file)) return
  assets.add(file)
  for (const dependency of staticImports(file)) {
    addStaticDependencies(assets, dependency)
  }
}

function pageRouteAssets(pageName) {
  const page = readdirSync(WEB_DIST).find(file =>
    new RegExp(`^${pageName}-.*\\.js$`).test(file),
  )
  if (!page)
    throw new Error(
      `web ${pageName} route chunk not found; run build:web first`,
    )
  const assets = new Set(initialWebAssets())
  addStaticDependencies(assets, page)
  return assets
}

function totalGzipSize(files) {
  return [...files].reduce((total, file) => total + assetGzipSize(file), 0)
}

const gates = [
  {
    name: 'web initial JS (gzip)',
    check: () => {
      return { size: totalGzipSize(initialWebAssets()), limit: 250_000 }
    },
  },
  {
    name: 'web default Chat route JS (gzip)',
    check: () => {
      return { size: totalGzipSize(pageRouteAssets('Chat')), limit: 300_000 }
    },
  },
  {
    name: 'web page chunks count',
    check: () => {
      const pageChunks = readdirSync(WEB_DIST).filter(f =>
        /^(Chat|Connect|Schedules|Settings)-.*\.js$/.test(f),
      )
      if (pageChunks.length === 0)
        throw new Error('web page chunks not found; run build:web first')
      return { size: pageChunks.length, limit: 10, unit: ' chunks' }
    },
  },
  {
    name: 'cli parseArgs module import (ms)',
    check: () => {
      const probe = `
        const t = performance.now()
        await import('./apps/cli/src/entrypoints/cli/cliParser/index.ts')
        console.log('PERF_GATE_IMPORT_MS', Math.round(performance.now() - t))
      `
      const out = execFileSync('bun', ['-e', probe], {
        cwd: rootDir,
        encoding: 'utf8',
        timeout: 60_000,
      })
      const line = out
        .split('\n')
        .find(l => l.startsWith('PERF_GATE_IMPORT_MS'))
      if (!line) throw new Error('startup probe produced no measurement')
      return { size: Number(line.split(' ')[1]), limit: 900 }
    },
  },
]

let failed = false
for (const gate of gates) {
  try {
    const {
      size,
      limit,
      unit = gate.name.includes('ms') ? 'ms' : 'B',
    } = gate.check()
    const ok = size <= limit
    console.log(
      `${ok ? 'PASS' : 'FAIL'} ${gate.name}: ${size}${unit} (limit ${limit}${unit})`,
    )
    if (!ok) failed = true
  } catch (error) {
    console.error(
      `ERROR ${gate.name}: ${error instanceof Error ? error.message : String(error)}`,
    )
    failed = true
  }
}

process.exit(failed ? 1 : 0)
