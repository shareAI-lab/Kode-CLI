import { watchFile, unwatchFile } from 'fs'
import { homedir } from 'os'
import { getSettingsFileCandidates } from '#config'

import {
  loadMergedSettings,
  normalizeSandboxRuntimeConfigFromSettings,
  type SandboxRuntimeConfig,
} from './sandboxConfig'

export type SandboxConfigListener = (config: SandboxRuntimeConfig) => void

export class SandboxConfigManager {
  private listeners = new Set<SandboxConfigListener>()
  private watchPaths: string[] = []
  private current: SandboxRuntimeConfig | null = null

  getCurrent(): SandboxRuntimeConfig {
    if (!this.current) {
      const settings = loadMergedSettings()
      this.current = normalizeSandboxRuntimeConfigFromSettings(settings)
    }
    return this.current
  }

  subscribe(listener: SandboxConfigListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  initialize(options?: { projectDir?: string; homeDir?: string }): void {
    const projectDir = options?.projectDir ?? process.cwd()
    const homeDir = options?.homeDir ?? homedir()
    const user = getSettingsFileCandidates({
      destination: 'userSettings',
      homeDir,
    })
    const userEnv = getSettingsFileCandidates({ destination: 'userSettings' })
    const project = getSettingsFileCandidates({
      destination: 'projectSettings',
      projectDir,
      homeDir,
    })
    const local = getSettingsFileCandidates({
      destination: 'localSettings',
      projectDir,
      homeDir,
    })

    const paths = [
      user?.primary,
      ...(user?.legacy ?? []),
      userEnv?.primary,
      ...(userEnv?.legacy ?? []),
      project?.primary,
      ...(project?.legacy ?? []),
      local?.primary,
      ...(local?.legacy ?? []),
    ].filter((p): p is string => Boolean(p))
    this.watchPaths = Array.from(new Set(paths))

    for (const p of this.watchPaths) {
      watchFile(p, { interval: 1000 }, () => {
        const settings = loadMergedSettings({ projectDir, homeDir })
        this.current = normalizeSandboxRuntimeConfigFromSettings(settings, {
          projectDir,
          homeDir,
        })
        for (const listener of this.listeners) listener(this.current)
      })
    }
  }

  close(): void {
    for (const p of this.watchPaths) {
      try {
        unwatchFile(p)
      } catch {
        /* no-op */
      }
    }
    this.watchPaths = []
  }
}
