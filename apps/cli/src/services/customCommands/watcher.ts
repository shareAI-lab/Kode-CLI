import { existsSync, readdirSync, statSync, watch, type FSWatcher } from 'fs'
import { dirname, join, resolve } from 'path'

import { debug as debugLogger } from '#core/utils/debugLogger'
import { getKodeBaseDir } from '#core/utils/env'
import { getCwd } from '#core/utils/state'
import { logError } from '#core/utils/log'

import { reloadCustomCommandsForSession } from './reload'

function hasGitSegment(filePath: string): boolean {
  // Match common watcher ignores to avoid noisy reloads for embedded repos.
  return filePath.split(/[\\/]/).some(part => part === '.git')
}

function listAncestorDirs(startDir: string, maxDepth = 50): string[] {
  const out: string[] = []
  let current = resolve(startDir)
  for (let depth = 0; depth < maxDepth; depth += 1) {
    out.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return out
}

function listSkillDirs(skillsDir: string): string[] {
  let entries
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true })
  } catch {
    return []
  }

  const out: string[] = []
  for (const entry of entries) {
    if (entry.name === '.git') continue
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    out.push(join(skillsDir, entry.name))
  }
  return out
}

function listChildDirs(parentDir: string): string[] {
  let entries
  try {
    entries = readdirSync(parentDir, { withFileTypes: true })
  } catch {
    return []
  }

  const out: string[] = []
  for (const entry of entries) {
    if (entry.name === '.git') continue
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    out.push(join(parentDir, entry.name))
  }
  return out
}

function getCandidateBaseDirs(): { skills: string[]; commands: string[] } {
  const cwd = getCwd()
  const userKodeBaseDir = getKodeBaseDir()
  const ancestors = listAncestorDirs(cwd)

  const commands = [
    join(userKodeBaseDir, 'commands'),
    ...ancestors.map(d => join(d, '.kode', 'commands')),
  ]

  const skills = [
    join(userKodeBaseDir, 'skills'),
    ...ancestors.map(d => join(d, '.kode', 'skills')),
  ]

  return { skills, commands }
}

let watchers: FSWatcher[] = []
let watchedDirPathsForTests = new Set<string>()
let watchEventCountForTests = 0
const WATCH_DEBOUNCE_MS = 50
const WRITE_STABILITY_THRESHOLD_MS = 1000
const WRITE_POLL_INTERVAL_MS = 500
let pendingTimer: ReturnType<typeof setTimeout> | null = null
let pendingPaths = new Set<string>()
let pendingOnChange: (() => void) | undefined
let watcherActive = false
let reloadGeneration = 0

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function readStableSnapshot(path: string): string | null {
  try {
    const stats = statSync(path)
    if (!stats.isFile() && !stats.isDirectory()) return null
    return `${stats.size}:${stats.mtimeMs}`
  } catch {
    return null
  }
}

async function awaitWriteFinish(
  changedPaths: string[],
  generation: number,
): Promise<void> {
  const paths = Array.from(new Set(changedPaths)).filter(
    p => p && !hasGitSegment(p),
  )
  if (paths.length === 0) return

  let stableSince = Date.now()
  const snapshots = new Map<string, string | null>()
  for (const path of paths) {
    snapshots.set(path, readStableSnapshot(path))
  }

  while (Date.now() - stableSince < WRITE_STABILITY_THRESHOLD_MS) {
    if (!watcherActive) return
    if (generation !== reloadGeneration) return

    await sleep(WRITE_POLL_INTERVAL_MS)

    let changed = false
    for (const path of paths) {
      const next = readStableSnapshot(path)
      const prev = snapshots.get(path) ?? null
      if (next !== prev) {
        snapshots.set(path, next)
        changed = true
      }
    }

    if (changed) {
      stableSince = Date.now()
    }
  }
}

function scheduleReload(): void {
  if (pendingTimer) {
    clearTimeout(pendingTimer)
  }
  reloadGeneration += 1
  const generation = reloadGeneration

  pendingTimer = setTimeout(() => {
    pendingTimer = null
    const changedPaths = Array.from(pendingPaths)
    pendingPaths.clear()

    void (async () => {
      if (!watcherActive) return
      await awaitWriteFinish(changedPaths, generation)
      if (!watcherActive) return
      if (generation !== reloadGeneration) return
      await reloadCustomCommandsForSession({ changedPaths })
      pendingOnChange?.()
      await rebuildWatchers()
    })()
  }, WATCH_DEBOUNCE_MS)
}

function addWatcher(dirPath: string, opts?: { recursive?: boolean }): boolean {
  const wantsRecursive = Boolean(opts?.recursive)

  const handler = (_eventType: string, filename: string | Buffer | null) => {
    watchEventCountForTests += 1
    if (filename) {
      const name = typeof filename === 'string' ? filename : filename.toString()
      const fullPath = join(dirPath, name)
      if (!hasGitSegment(fullPath)) {
        pendingPaths.add(fullPath)
      }
    }
    scheduleReload()
  }

  try {
    const watcher = watch(dirPath, { recursive: wantsRecursive }, handler)
    watchers.push(watcher)
    watchedDirPathsForTests.add(dirPath)
    return wantsRecursive
  } catch (error) {
    if (wantsRecursive) {
      try {
        const watcher = watch(dirPath, { recursive: false }, handler)
        watchers.push(watcher)
        watchedDirPathsForTests.add(dirPath)
        return false
      } catch {
        // fall through to logging below
      }
    }
    logError(error)
    debugLogger.warn('CUSTOM_COMMAND_WATCH_FAILED', {
      dirPath,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

async function rebuildWatchers(): Promise<void> {
  for (const watcher of watchers) {
    try {
      watcher.close()
    } catch {
      // ignore
    }
  }
  watchers = []
  watchedDirPathsForTests.clear()
  watchEventCountForTests = 0

  const { skills, commands } = getCandidateBaseDirs()
  // Keep behavior consistent across runtimes and match the default watch depth
  // used upstream (depth=2).
  const wantsRecursive = false
  const watchedDirs = new Set<string>()
  const watchDir = (dirPath: string, recursive: boolean): boolean => {
    const resolved = resolve(dirPath)
    if (watchedDirs.has(resolved)) return false
    watchedDirs.add(resolved)
    return addWatcher(dirPath, { recursive })
  }

  for (const dirPath of skills) {
    if (!existsSync(dirPath)) continue
    const usedRecursive = watchDir(dirPath, wantsRecursive)
    for (const skillDir of listSkillDirs(dirPath)) {
      if (!existsSync(skillDir)) continue
      watchDir(skillDir, false)
      if (!usedRecursive) {
        // Watch skills at depth=2 (skill dir + one nested directory like
        // references/ or scripts/). This avoids watching arbitrarily deep trees
        // under Bun/Linux while still supporting the common skill pack layout.
        for (const childDir of listChildDirs(skillDir)) {
          if (!existsSync(childDir)) continue
          watchDir(childDir, false)
        }
      }
    }
  }

  for (const dirPath of commands) {
    if (!existsSync(dirPath)) continue
    const usedRecursive = watchDir(dirPath, wantsRecursive)
    if (usedRecursive) continue

    // Watch commands at depth=2 (base + children + grandchildren).
    for (const childDir of listChildDirs(dirPath)) {
      if (!existsSync(childDir)) continue
      watchDir(childDir, false)
      for (const grandChildDir of listChildDirs(childDir)) {
        if (!existsSync(grandChildDir)) continue
        watchDir(grandChildDir, false)
      }
    }
  }
}

export async function startCustomCommandWatcher(
  onChange?: () => void,
): Promise<void> {
  await stopCustomCommandWatcher()
  pendingOnChange = onChange
  watcherActive = true
  await rebuildWatchers()
}

export async function stopCustomCommandWatcher(): Promise<void> {
  try {
    for (const watcher of watchers) {
      try {
        watcher.close()
      } catch {
        // ignore
      }
    }
  } finally {
    watchers = []
    watchedDirPathsForTests.clear()
    watchEventCountForTests = 0
    watcherActive = false
    reloadGeneration += 1
    if (pendingTimer) {
      clearTimeout(pendingTimer)
      pendingTimer = null
    }
    pendingPaths.clear()
    pendingOnChange = undefined
  }
}

export async function refreshCustomCommandWatcher(): Promise<void> {
  if (!watcherActive) return
  await rebuildWatchers()
}

export function __getWatchedDirPathsForTests(): string[] {
  return Array.from(watchedDirPathsForTests)
}

export function __getWatchEventCountForTests(): number {
  return watchEventCountForTests
}
