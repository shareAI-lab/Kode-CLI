// Unified CLI entry (lightweight)
// - Development: use `bun run apps/cli/src/dispatch.ts`
// - Production: transpiled to `dist/index.js` and used as bin/main

import { MACRO } from '#core/constants/macros'

function hasFlag(...flags: string[]): boolean {
  return process.argv.some(arg => flags.includes(arg))
}

// Minimal pre-parse: handle version/help early without loading heavy UI modules
if (hasFlag('--version', '-v', '-V')) {
  process.stdout.write(`${MACRO.VERSION || ''}\n`)
  process.exit(0)
}

if (hasFlag('--help-lite')) {
  process.stdout.write(
    `Usage: kode [options] [command] [prompt]\n\n` +
      `Common options:\n` +
      `  -h, --help           Show full help\n` +
      `  -v, --version        Show version\n` +
      `  -p, --print          Print response and exit (non-interactive)\n` +
      `  --headless           Run without the TUI (alias for --print)\n` +
      `  --cwd <cwd>          Set working directory\n` +
      `  -r, --resume [q]     Resume by session ID/name, or open picker with optional search\n` +
      `  -c, --continue       Continue the most recent conversation\n`,
  )
  process.exit(0)
}

// For compatibility, --help loads full CLI help.
// NOTE: ACP mode is hosted by the server app (merged per blueprint).
async function main(): Promise<void> {
  if (process.argv[2] === '--ripgrep') {
    const args = process.argv.slice(3)
    const [{ ensureRipgrepReady }, { spawnSync }] = await Promise.all([
      import('#core/utils/ripgrep'),
      import('node:child_process'),
    ])

    try {
      const rg = await ensureRipgrepReady()
      const result = spawnSync(rg, args, { stdio: 'inherit' })
      process.exitCode =
        typeof result.status === 'number'
          ? result.status
          : result.signal || result.error
            ? 1
            : 0
    } catch (error) {
      console.error(error)
      process.exitCode = 1
    }
    return
  }

  if (process.argv[2] === '--mcp-cli') {
    const args = process.argv.slice(3)
    let cwd = process.cwd()
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] ?? ''
      if (arg === '--cwd' && args[i + 1]) {
        cwd = String(args[i + 1])
        break
      }
      if (arg.startsWith('--cwd=')) {
        cwd = arg.slice('--cwd='.length)
        break
      }
    }

    const { runMcpCli } = await import('./entrypoints/mcpCli.ts')
    process.exitCode = await runMcpCli({ argv: args, cwd })
    return
  }

  if (process.argv[2] === '--mcp-server') {
    const args = process.argv.slice(3)
    let cwd = process.cwd()
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] ?? ''
      if (arg === '--cwd' && args[i + 1]) {
        cwd = String(args[i + 1])
        break
      }
      if (arg.startsWith('--cwd=')) {
        cwd = arg.slice('--cwd='.length)
        break
      }
    }

    const [{ startMCPServer }, { getAllTools }] = await Promise.all([
      import('#core/mcp/server'),
      import('#tools'),
    ])
    await startMCPServer(cwd, getAllTools())
    return
  }

  if (
    process.argv[2] === '--claude-in-chrome-mcp' ||
    process.argv[2] === '--chrome-native-host'
  ) {
    process.stderr.write(
      [
        `Error: ${process.argv[2]} is not supported in Kode.`,
        'This flag is accepted for CLI compatibility, but the browser integration runtime is not implemented yet.',
      ].join('\n') + '\n',
    )
    process.exitCode = 1
    return
  }

  if (hasFlag('--acp')) {
    await import('./entrypoints/daemon.ts')
    return
  }

  // Attach core diagnostics before loading provider transport modules.
  const { bindAiDebugFromCore } = await import('./bindAiDebug.ts')
  bindAiDebugFromCore()

  await import('./entrypoints/cli.ts')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
