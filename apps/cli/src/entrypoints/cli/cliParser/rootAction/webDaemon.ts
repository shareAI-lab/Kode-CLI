import type { KodeDaemon } from '#daemon/server'

let activeWebDaemon: KodeDaemon | null = null
let cleanupRegistered = false

function registerCleanup() {
  if (cleanupRegistered) return
  cleanupRegistered = true
  process.on('exit', () => {
    try {
      activeWebDaemon?.stop()
    } catch {
      /* no-op */
    }
  })
}

function parseWebPort(value: string | undefined): number {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return 0
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

export async function startWebDaemon(args: {
  cwd: string
  webHost?: string
  webPort?: string
}): Promise<string> {
  const host =
    typeof args.webHost === 'string' && args.webHost.trim()
      ? args.webHost.trim()
      : undefined
  const port = parseWebPort(args.webPort)

  const { startKodeDaemon } = await import('#daemon/server')

  try {
    activeWebDaemon?.stop()
  } catch {
    /* no-op */
  }

  activeWebDaemon = await startKodeDaemon({
    host,
    port,
    cwd: args.cwd,
  })
  registerCleanup()

  return activeWebDaemon.url
}
