import { getContext } from '#core/context'
import { getCurrentProjectConfig } from '#core/utils/config'
import { cleanupOldMessageFilesInBackground } from '#core/utils/cleanup'
import { grantReadPermissionForOriginalDir } from '#core/utils/permissions/filesystem'
import { setCwd, setOriginalCwd } from '#core/utils/state'
import { debug as debugLogger } from '#core/utils/debugLogger'
import { LEGACY_ENV } from '#config/compat/legacyEnv'
import { loadToolPermissionContextFromDisk } from '#core/permissions/toolPermissionSettings'

export async function setup(cwd: string, safeMode?: boolean): Promise<void> {
  process.env.KODE_PROJECT_DIR = cwd
  process.env[LEGACY_ENV.projectDir] = cwd

  // Set both current and original working directory if --cwd was provided
  if (cwd !== process.cwd()) {
    setOriginalCwd(cwd)
  }
  await setCwd(cwd)

  // Validate all policy sources before watchers, hooks, plugins or model calls,
  // including interactive and plain-text print entrypoints.
  loadToolPermissionContextFromDisk({ projectDir: cwd })

  // Always grant read permissions for original working dir
  grantReadPermissionForOriginalDir()

  // Start watching agent configuration files for changes
  // Try ESM-friendly path first (compiled dist), then fall back to extensionless (dev/tsx)
  let agentLoader: any
  try {
    agentLoader = await import('#core/utils/agentLoader')
  } catch {
    agentLoader = await import('#core/utils/agentLoader')
  }
  const { startAgentWatcher } = agentLoader
  await startAgentWatcher(() => {
    // Cache is already cleared in the watcher, just log
    debugLogger.info('AGENTS_HOT_RELOADED', { ok: true })
  })

  // If --safe mode is enabled, prevent root/sudo usage for security
  if (safeMode) {
    // Check if running as root/sudo on Unix-like systems
    if (
      process.platform !== 'win32' &&
      typeof process.getuid === 'function' &&
      process.getuid() === 0
    ) {
      console.error(
        `--safe mode cannot be used with root/sudo privileges for security reasons`,
      )
      process.exit(1)
    }
  }

  if (process.env.NODE_ENV === 'test') {
    return
  }

  const { startCustomCommandWatcher } =
    await import('#cli-services/customCommands')
  await startCustomCommandWatcher(() => {
    debugLogger.info('CUSTOM_COMMANDS_HOT_RELOADED', { ok: true })
  })

  cleanupOldMessageFilesInBackground()
  getContext() // Pre-fetch all context data at once

  // Check for last session's cost and duration
  const projectConfig = getCurrentProjectConfig()
  if (
    projectConfig.lastCost !== undefined &&
    projectConfig.lastDuration !== undefined
  ) {
    // Clear the values after logging
    // saveCurrentProjectConfig({
    //   ...projectConfig,
    //   lastCost: undefined,
    //   lastAPIDuration: undefined,
    //   lastDuration: undefined,
    //   lastSessionId: undefined,
    // })
  }

  // Skip interactive auto-updater permission prompts during startup
  // Users can still run the doctor command manually if desired.
}
