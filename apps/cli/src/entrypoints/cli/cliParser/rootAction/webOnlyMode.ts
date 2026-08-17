import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { LEGACY_ENV } from '#core/compat/legacyEnv'
import { openBrowser } from '#core/utils/browser'

function getKodeConfigDir(): string {
  const envDir =
    process.env.KODE_CONFIG_DIR ?? process.env[LEGACY_ENV.configDir]
  if (envDir && envDir.trim()) return envDir.trim()
  return join(homedir(), '.kode')
}

const MIN_WEB_TOKEN_LENGTH = 32

function hardenTokenFilePermissions(tokenFile: string): void {
  if (process.platform === 'win32') return
  try {
    chmodSync(tokenFile, 0o600)
  } catch {
    // The token remains usable on filesystems that do not expose POSIX modes.
  }
}

export function getOrCreateWebToken(): string {
  const configDir = getKodeConfigDir()
  const tokenFile = join(configDir, 'web-token')

  if (existsSync(tokenFile)) {
    try {
      const token = readFileSync(tokenFile, 'utf-8').trim()
      if (token.length >= MIN_WEB_TOKEN_LENGTH) {
        hardenTokenFilePermissions(tokenFile)
        return token
      }
    } catch {
      /* no-op */
    }
  }

  const newToken = randomUUID().replace(/-/g, '')
  try {
    mkdirSync(configDir, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') chmodSync(configDir, 0o700)
    writeFileSync(tokenFile, newToken, { encoding: 'utf-8', mode: 0o600 })
    hardenTokenFilePermissions(tokenFile)
  } catch {
    /* no-op */
  }

  return newToken
}

export async function runWebOnlyMode(args: {
  cwd: string
  webHost?: string
  webPort?: string
}): Promise<void> {
  const { startKodeDaemon } = await import('#daemon/server')

  const host =
    typeof args.webHost === 'string' && args.webHost.trim()
      ? args.webHost.trim()
      : undefined

  const port = (() => {
    const raw = typeof args.webPort === 'string' ? args.webPort.trim() : ''
    if (!raw) return 0
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? n : 0
  })()

  const token = getOrCreateWebToken()

  const daemon = await startKodeDaemon({
    host,
    port,
    token,
    cwd: args.cwd,
  })

  const link = `\x1b]8;;${daemon.url}\x07${daemon.url}\x1b]8;;\x07`

  console.log('')
  console.log('Kode Web Server')
  console.log('')
  console.log(`  ${link}`)
  console.log('')
  console.log('Press Ctrl+C to stop')
  console.log('')

  void openBrowser(daemon.url)

  await new Promise<void>(resolve => {
    const cleanup = () => {
      daemon.stop()
      resolve()
    }
    process.on('SIGINT', cleanup)
    process.on('SIGTERM', cleanup)
  })
}
