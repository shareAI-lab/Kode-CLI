type SemverModule = {
  gt?: (a: string, b: string) => boolean
}

function resolveSemverModule(semverMod: unknown): SemverModule {
  if (semverMod && typeof semverMod === 'object') {
    const record = semverMod as Record<string, unknown>
    const directGt = record.gt
    if (typeof directGt === 'function') {
      return { gt: directGt as (a: string, b: string) => boolean }
    }
    const def = record.default
    if (def && typeof def === 'object') {
      const defRecord = def as Record<string, unknown>
      const defGt = defRecord.gt
      if (typeof defGt === 'function') {
        return { gt: defGt as (a: string, b: string) => boolean }
      }
    }
  }
  return {}
}

export type UpdateInfo = { version: string | null; commands: string[] | null }

export async function fetchUpdateInfo(
  currentVersion: string,
): Promise<UpdateInfo> {
  try {
    const [{ getLatestVersion, getUpdateCommandSuggestions }, semverMod] =
      await Promise.all([import('#core/utils/autoUpdater'), import('semver')])

    const semver = resolveSemverModule(semverMod)
    if (!semver.gt) return { version: null, commands: null }

    const latest = await getLatestVersion()
    if (latest && semver.gt(latest, currentVersion)) {
      const cmds = await getUpdateCommandSuggestions()
      return { version: latest, commands: cmds }
    }
  } catch {
    /* no-op */
  }

  return { version: null, commands: null }
}
