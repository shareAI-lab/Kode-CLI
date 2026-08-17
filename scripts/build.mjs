#!/usr/bin/env bun
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve, sep } from 'node:path'
import * as esbuild from 'esbuild'

const OUT_DIR = 'dist'
const allowMissingWebUi = process.env.KODE_ALLOW_MISSING_WEBUI === '1'

async function buildNodeRuntime() {
  await esbuild.build({
    entryPoints: {
      index: 'apps/cli/src/dispatch.ts',
      'entrypoints/cli': 'apps/cli/src/entrypoints/cli.ts',
      'entrypoints/mcp': 'packages/mcp/src/index.ts',
      'entrypoints/daemon': 'apps/cli/src/entrypoints/daemon.ts',
    },
    outdir: OUT_DIR,
    bundle: true,
    platform: 'node',
    format: 'esm',
    splitting: true,
    sourcemap: 'external',
    target: ['node20'],
    tsconfig: 'tsconfig.json',
    packages: 'external',
    entryNames: '[dir]/[name]',
    chunkNames: 'chunks/[name]-[hash]',
    minify: false,
  })
}

async function buildSdkEntry(options) {
  await esbuild.build({
    entryPoints: [options.entrypoint],
    outfile: options.outfile,
    bundle: true,
    platform: 'node',
    format: options.format,
    sourcemap: 'external',
    target: ['node20'],
    tsconfig: 'tsconfig.json',
    packages: 'external',
    splitting: false,
    minify: false,
    ...(options.format === 'cjs'
      ? {
          // We intentionally ship a CJS build for `require()`. Some files contain
          // an `import.meta.url` fallback for ESM builds, which is safe but
          // triggers this esbuild warning in CJS output.
          logOverride: {
            'empty-import-meta': 'silent',
          },
        }
      : null),
  })
}

function runOrThrow(cmd, options) {
  const proc = Bun.spawnSync({
    cmd,
    stdout: 'inherit',
    stderr: 'inherit',
    ...options,
  })

  if (proc.exitCode !== 0) {
    throw new Error(`Command failed (${proc.exitCode}): ${cmd.join(' ')}`)
  }
}

async function main() {
  console.log('🚀 Building Kode (Node runtime baseline)...')

  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(join(OUT_DIR, 'entrypoints'), { recursive: true })
  mkdirSync(join(OUT_DIR, 'sdk'), { recursive: true })

  // Build Node runtime entrypoints (preserve lightweight index.js + split chunks)
  await buildNodeRuntime()

  // Build SDK entrypoints (subpath exports)
  await buildSdkEntry({
    entrypoint: 'packages/protocol/src/index.ts',
    outfile: join(OUT_DIR, 'sdk', 'protocol.js'),
    format: 'esm',
  })
  await buildSdkEntry({
    entrypoint: 'apps/server/src/client.ts',
    outfile: join(OUT_DIR, 'sdk', 'daemon-client.js'),
    format: 'esm',
  })
  await buildSdkEntry({
    entrypoint: 'packages/core/src/index.ts',
    outfile: join(OUT_DIR, 'sdk', 'core.js'),
    format: 'esm',
  })
  await buildSdkEntry({
    entrypoint: 'packages/runtime/src/index.ts',
    outfile: join(OUT_DIR, 'sdk', 'runtime.js'),
    format: 'esm',
  })
  await buildSdkEntry({
    entrypoint: 'packages/runtime/src/node.ts',
    outfile: join(OUT_DIR, 'sdk', 'runtime-node.js'),
    format: 'esm',
  })
  await buildSdkEntry({
    entrypoint: 'packages/client/src/index.ts',
    outfile: join(OUT_DIR, 'sdk', 'client.js'),
    format: 'esm',
  })
  await buildSdkEntry({
    entrypoint: 'packages/tools/src/index.ts',
    outfile: join(OUT_DIR, 'sdk', 'tools.js'),
    format: 'esm',
  })

  await buildSdkEntry({
    entrypoint: 'packages/protocol/src/index.ts',
    outfile: join(OUT_DIR, 'sdk', 'protocol.cjs'),
    format: 'cjs',
  })
  await buildSdkEntry({
    entrypoint: 'apps/server/src/client.ts',
    outfile: join(OUT_DIR, 'sdk', 'daemon-client.cjs'),
    format: 'cjs',
  })
  await buildSdkEntry({
    entrypoint: 'packages/core/src/index.ts',
    outfile: join(OUT_DIR, 'sdk', 'core.cjs'),
    format: 'cjs',
  })
  await buildSdkEntry({
    entrypoint: 'packages/runtime/src/index.ts',
    outfile: join(OUT_DIR, 'sdk', 'runtime.cjs'),
    format: 'cjs',
  })
  await buildSdkEntry({
    entrypoint: 'packages/runtime/src/node.ts',
    outfile: join(OUT_DIR, 'sdk', 'runtime-node.cjs'),
    format: 'cjs',
  })
  await buildSdkEntry({
    entrypoint: 'packages/client/src/index.ts',
    outfile: join(OUT_DIR, 'sdk', 'client.cjs'),
    format: 'cjs',
  })
  await buildSdkEntry({
    entrypoint: 'packages/tools/src/index.ts',
    outfile: join(OUT_DIR, 'sdk', 'tools.cjs'),
    format: 'cjs',
  })

  // Release builds require the WebUI. Local diagnostic builds may explicitly
  // opt out with KODE_ALLOW_MISSING_WEBUI=1.
  try {
    const webConfigPath = join('apps', 'web', 'vite.config.ts')
    if (!existsSync(webConfigPath)) {
      throw new Error(`${webConfigPath} was not found`)
    }

    runOrThrow([
      'bun',
      'x',
      'vite',
      'build',
      '--config',
      'apps/web/vite.config.ts',
    ])
    const srcWebDist = join('apps', 'web', 'dist')
    if (existsSync(join(srcWebDist, 'index.html'))) {
      cpSync(srcWebDist, join(OUT_DIR, 'webui'), { recursive: true })
      const serverStaticDir = join('apps', 'server', 'static')
      rmSync(serverStaticDir, { recursive: true, force: true })
      mkdirSync(serverStaticDir, { recursive: true })
      cpSync(srcWebDist, serverStaticDir, { recursive: true })
    } else {
      throw new Error(
        'WebUI build completed but apps/web/dist/index.html was not found',
      )
    }
  } catch (err) {
    if (!allowMissingWebUi) throw err
    console.warn(
      '⚠️  Skipping unavailable WebUI because KODE_ALLOW_MISSING_WEBUI=1:',
      err instanceof Error ? err.message : String(err),
    )
  }

  // Mark dist as ESM for interoperability (some tooling still expects this)
  writeFileSync(
    join(OUT_DIR, 'package.json'),
    JSON.stringify({ type: 'module', main: './index.js' }, null, 2),
  )

  // Copy yoga.wasm alongside outputs (helps in environments where root assets are stripped)
  try {
    cpSync('yoga.wasm', join(OUT_DIR, 'yoga.wasm'))
  } catch (err) {
    console.warn(
      '⚠️  Could not copy yoga.wasm:',
      err instanceof Error ? err.message : String(err),
    )
  }

  // Best-effort: build Linux seccomp assets for the current arch (Unix socket blocking).
  // CI release workflows assemble both x64+arm64 assets before publishing the main package.
  if (process.platform === 'linux') {
    try {
      runOrThrow(['node', 'scripts/build-seccomp-assets.mjs'])
    } catch (err) {
      console.warn(
        '⚠️  Could not build Linux seccomp assets:',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  // Copy vendor assets if present (future bundled tools).
  // NOTE: ripgrep is distributed via npm optionalDependencies to avoid GitHub downloads
  // and to keep the main package small.
  try {
    if (existsSync('vendor')) {
      const vendorRoot = resolve('vendor')
      const ripgrepRoot = resolve('vendor', 'ripgrep')
      cpSync('vendor', join(OUT_DIR, 'vendor'), {
        recursive: true,
        filter: src => {
          const abs = resolve(src)
          if (abs === ripgrepRoot) return false
          if (abs.startsWith(ripgrepRoot + sep)) return false
          // Also skip the "vendor/ripgrep" path on platforms where `resolve()` normalizes differently.
          if (abs === vendorRoot + sep + 'ripgrep') return false
          if (abs.startsWith(vendorRoot + sep + 'ripgrep' + sep)) return false
          return true
        },
      })
    }
  } catch (err) {
    console.warn(
      '⚠️  Could not copy vendor assets:',
      err instanceof Error ? err.message : String(err),
    )
  }

  // Generate Node-based CLI shim (npm bin points here)
  // - Prefer native binary via npm optionalDependencies (@shareai-lab/kode-bin-<platform>-<arch>)
  // - Fallback to Node runtime (no Bun required)
  cpSync(join('scripts', 'cli-wrapper.cjs'), 'cli.js')
  try {
    chmodSync('cli.js', 0o755)
  } catch (err) {
    console.warn(
      '⚠️  Could not make cli.js executable:',
      err instanceof Error ? err.message : String(err),
    )
  }

  // Generate Node-based ACP shim (npm bin points here)
  cpSync(join('scripts', 'cli-acp-wrapper.cjs'), 'cli-acp.js')
  try {
    chmodSync('cli-acp.js', 0o755)
  } catch (err) {
    console.warn(
      '⚠️  Could not make cli-acp.js executable:',
      err instanceof Error ? err.message : String(err),
    )
  }

  // Generate Node-based mcp-cli shim (npm bin points here)
  cpSync(join('scripts', 'mcp-cli-wrapper.cjs'), 'mcp-cli.js')
  try {
    chmodSync('mcp-cli.js', 0o755)
  } catch (err) {
    console.warn(
      '⚠️  Could not make mcp-cli.js executable:',
      err instanceof Error ? err.message : String(err),
    )
  }

  console.log('✅ Build completed')
  console.log('📋 Outputs:')
  console.log('  - dist/index.js')
  console.log('  - dist/entrypoints/cli.js')
  console.log('  - dist/entrypoints/mcp.js')
  console.log('  - dist/entrypoints/daemon.js')
  console.log('  - dist/sdk/protocol.js (+ .cjs)')
  console.log('  - dist/sdk/daemon-client.js (+ .cjs)')
  console.log('  - dist/sdk/core.js (+ .cjs)')
  console.log('  - dist/sdk/runtime.js (+ .cjs)')
  console.log('  - dist/sdk/runtime-node.js (+ .cjs)')
  console.log('  - dist/sdk/client.js (+ .cjs)')
  console.log('  - dist/sdk/tools.js (+ .cjs)')
  console.log('  - dist/webui/* (required unless explicitly opted out)')
  console.log('  - apps/server/static/* (required unless explicitly opted out)')
  console.log('  - cli.js')
  console.log('  - cli-acp.js')
  console.log('  - mcp-cli.js')
}

main().catch(err => {
  console.error('❌ Build failed:', err)
  process.exit(1)
})
