import { existsSync, readdirSync, statSync, type Dirent } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import { matchAdvanced } from './advancedFuzzyMatcher'
import type { UnifiedSuggestion } from './types'

function isDirectoryEntry(entry: Dirent, directory: string): boolean {
  if (entry.isDirectory()) return true
  if (!entry.isSymbolicLink()) return false

  try {
    return statSync(join(directory, entry.name)).isDirectory()
  } catch {
    // A broken or unreadable symbolic link should not hide the other entries.
    return false
  }
}

export function generateFileSuggestions(args: {
  prefix: string
  cwd: string
}): UnifiedSuggestion[] {
  const { prefix, cwd } = args

  try {
    const userPath = prefix || '.'
    const isAbsolutePath = userPath.startsWith('/')
    const isHomePath = userPath.startsWith('~')

    let searchPath: string
    if (isHomePath) {
      searchPath = userPath.replace('~', process.env.HOME || '')
    } else if (isAbsolutePath) {
      searchPath = userPath
    } else {
      searchPath = resolve(cwd, userPath)
    }

    const endsWithSlash = userPath.endsWith('/')
    const searchStat = existsSync(searchPath) ? statSync(searchPath) : null

    let searchDir: string
    let nameFilter: string

    if (endsWithSlash || searchStat?.isDirectory()) {
      searchDir = searchPath
      nameFilter = ''
    } else {
      searchDir = dirname(searchPath)
      nameFilter = basename(searchPath)
    }

    if (!existsSync(searchDir)) return []

    const showHidden = nameFilter.startsWith('.') || userPath.includes('/.')
    const lowerNameFilter = nameFilter.toLowerCase()
    const useFuzzy = lowerNameFilter.length >= 2
    // Single pass: compute the expensive fuzzy match once per entry instead of
    // running it twice (once to filter, once to score) for every fuzzy hit.
    const matches: Array<{
      entry: Dirent
      isDir: boolean
      prefixMatch: boolean
      fuzzyScore: number
    }> = []
    for (const entry of readdirSync(searchDir, { withFileTypes: true })) {
      if (!showHidden && entry.name.startsWith('.')) continue
      if (!nameFilter) {
        matches.push({
          entry,
          isDir: isDirectoryEntry(entry, searchDir),
          prefixMatch: false,
          fuzzyScore: 0,
        })
        continue
      }
      const lower = entry.name.toLowerCase()
      if (lower.startsWith(lowerNameFilter)) {
        matches.push({
          entry,
          isDir: isDirectoryEntry(entry, searchDir),
          prefixMatch: true,
          fuzzyScore: 0,
        })
        continue
      }
      // Fuzzy fallback (abbreviations/subsequences) so e.g. "pkg" matches
      // "package.json". Gated on 2+ chars to avoid noise.
      if (!useFuzzy) continue
      const fuzzy = matchAdvanced(entry.name, nameFilter)
      if (fuzzy.matched) {
        matches.push({
          entry,
          isDir: isDirectoryEntry(entry, searchDir),
          prefixMatch: false,
          fuzzyScore: fuzzy.score,
        })
      }
    }
    const entries = matches
      .sort((a, b) => {
        if (a.isDir && !b.isDir) return -1
        if (!a.isDir && b.isDir) return 1

        if (a.prefixMatch !== b.prefixMatch) {
          return a.prefixMatch ? -1 : 1
        }
        if (a.fuzzyScore !== b.fuzzyScore) {
          return b.fuzzyScore - a.fuzzyScore
        }
        return a.entry.name
          .toLowerCase()
          .localeCompare(b.entry.name.toLowerCase())
      })
      .slice(0, 25)
      .map(({ entry, isDir }) => {
        const entryName = entry.name
        const icon = isDir ? '📁' : '📄'

        let value: string

        if (userPath.includes('/')) {
          if (endsWithSlash) {
            value = userPath + entryName + (isDir ? '/' : '')
          } else if (searchStat?.isDirectory()) {
            value = userPath + '/' + entryName + (isDir ? '/' : '')
          } else {
            const userDir = userPath.includes('/')
              ? userPath.substring(0, userPath.lastIndexOf('/'))
              : ''
            value = userDir
              ? userDir + '/' + entryName + (isDir ? '/' : '')
              : entryName + (isDir ? '/' : '')
          }
        } else {
          if (searchStat?.isDirectory()) {
            value = userPath + '/' + entryName + (isDir ? '/' : '')
          } else {
            value = entryName + (isDir ? '/' : '')
          }
        }

        return {
          value,
          displayValue: `${icon} ${entryName}${isDir ? '/' : ''}`,
          type: 'file' as const,
          score: isDir ? 80 : 70,
        }
      })

    return entries
  } catch {
    return []
  }
}
