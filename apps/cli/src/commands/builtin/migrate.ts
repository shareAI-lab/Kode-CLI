import { existsSync, mkdirSync, readdirSync, copyFileSync, statSync, readFileSync, renameSync } from 'fs'
import { join, relative } from 'path'
import type { Command } from '../types'
import { PRODUCT_NAME } from '#core/constants/product'
import { getCwd } from '#core/utils/state'
import { getKodeBaseDir } from '#core/utils/env'
import { getClaudeCompatRoots } from '#config'

interface MigrateResult {
  migrated: string[]
  skipped: string[]
  errors: string[]
}

function copyDirRecursive(src: string, dest: string, result: MigrateResult): void {
  if (!existsSync(src)) return

  mkdirSync(dest, { recursive: true })

  const entries = readdirSync(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)

    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath, result)
    } else {
      if (existsSync(destPath)) {
        result.skipped.push(`${destPath} (already exists)`)
      } else {
        try {
          copyFileSync(srcPath, destPath)
          result.migrated.push(`${srcPath} → ${destPath}`)
        } catch (e) {
          result.errors.push(`Failed to copy ${srcPath}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
  }
}

function migrateProjectLevel(cwd: string, result: MigrateResult): void {
  const claudeDir = join(cwd, '.claude')
  const kodeDir = join(cwd, '.kode')

  // Migrate .claude/ directory to .kode/
  if (existsSync(claudeDir)) {
    const subdirs = ['commands', 'skills', 'agents', 'output-styles']
    for (const subdir of subdirs) {
      const src = join(claudeDir, subdir)
      const dest = join(kodeDir, subdir)
      if (existsSync(src)) {
        copyDirRecursive(src, dest, result)
      }
    }

    // Migrate settings files
    const settingsFiles = ['settings.json', 'settings.local.json']
    for (const file of settingsFiles) {
      const src = join(claudeDir, file)
      const dest = join(kodeDir, file)
      if (existsSync(src)) {
        if (existsSync(dest)) {
          result.skipped.push(`${dest} (already exists)`)
        } else {
          try {
            mkdirSync(kodeDir, { recursive: true })
            copyFileSync(src, dest)
            result.migrated.push(`${src} → ${dest}`)
          } catch (e) {
            result.errors.push(`Failed to copy ${src}: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
      }
    }
  }

  // Migrate CLAUDE.md → AGENTS.md
  const claudeMd = join(cwd, 'CLAUDE.md')
  const agentsMd = join(cwd, 'AGENTS.md')
  if (existsSync(claudeMd)) {
    if (existsSync(agentsMd)) {
      // If AGENTS.md already exists, append CLAUDE.md content
      try {
        const claudeContent = readFileSync(claudeMd, 'utf-8')
        const agentsContent = readFileSync(agentsMd, 'utf-8')
        if (!agentsContent.includes(claudeContent.trim())) {
          result.skipped.push(`CLAUDE.md → AGENTS.md (AGENTS.md already exists, manual merge recommended)`)
        } else {
          result.skipped.push(`CLAUDE.md content already present in AGENTS.md`)
        }
      } catch (e) {
        result.errors.push(`Failed to read CLAUDE.md/AGENTS.md: ${e instanceof Error ? e.message : String(e)}`)
      }
    } else {
      try {
        copyFileSync(claudeMd, agentsMd)
        result.migrated.push(`CLAUDE.md → AGENTS.md`)
      } catch (e) {
        result.errors.push(`Failed to migrate CLAUDE.md: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
}

function migrateUserLevel(result: MigrateResult): void {
  const kodeBaseDir = getKodeBaseDir()
  const claudeRoots = getClaudeCompatRoots()

  for (const claudeRoot of claudeRoots) {
    if (!existsSync(claudeRoot)) continue

    const subdirs = ['commands', 'skills', 'agents', 'output-styles']
    for (const subdir of subdirs) {
      const src = join(claudeRoot, subdir)
      const dest = join(kodeBaseDir, subdir)
      if (existsSync(src)) {
        copyDirRecursive(src, dest, result)
      }
    }

    // Migrate user-level settings.json
    const src = join(claudeRoot, 'settings.json')
    const dest = join(kodeBaseDir, 'settings.json')
    if (existsSync(src)) {
      if (existsSync(dest)) {
        result.skipped.push(`${dest} (already exists)`)
      } else {
        try {
          mkdirSync(kodeBaseDir, { recursive: true })
          copyFileSync(src, dest)
          result.migrated.push(`${src} → ${dest}`)
        } catch (e) {
          result.errors.push(`Failed to copy ${src}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
  }
}

const migrate = {
  type: 'local',
  name: 'migrate',
  description: `Migrate .claude configuration to .kode (CLAUDE.md → AGENTS.md)`,
  isEnabled: true,
  isHidden: false,
  argumentHint: '[--project | --user | --all]',
  userFacingName() {
    return 'migrate'
  },
  async call(args: string) {
    const cwd = getCwd()
    const result: MigrateResult = { migrated: [], skipped: [], errors: [] }

    const trimmedArgs = args.trim()
    const doProject = !trimmedArgs || trimmedArgs === '--project' || trimmedArgs === '--all'
    const doUser = trimmedArgs === '--user' || trimmedArgs === '--all'

    if (doProject) {
      migrateProjectLevel(cwd, result)
    }

    if (doUser) {
      migrateUserLevel(result)
    }

    // Build output
    const lines: string[] = [`${PRODUCT_NAME} Migration Report`]
    lines.push('═'.repeat(40))

    if (result.migrated.length === 0 && result.skipped.length === 0 && result.errors.length === 0) {
      lines.push('')
      lines.push('Nothing to migrate. No .claude configuration or CLAUDE.md found.')
      lines.push('')
      lines.push(`${PRODUCT_NAME} already uses .kode/ and AGENTS.md by default.`)
      return lines.join('\n')
    }

    if (result.migrated.length > 0) {
      lines.push('')
      lines.push(`✓ Migrated (${result.migrated.length}):`)
      for (const item of result.migrated) {
        lines.push(`  • ${item}`)
      }
    }

    if (result.skipped.length > 0) {
      lines.push('')
      lines.push(`⊘ Skipped (${result.skipped.length}):`)
      for (const item of result.skipped) {
        lines.push(`  • ${item}`)
      }
    }

    if (result.errors.length > 0) {
      lines.push('')
      lines.push(`✗ Errors (${result.errors.length}):`)
      for (const item of result.errors) {
        lines.push(`  • ${item}`)
      }
    }

    lines.push('')
    lines.push('─'.repeat(40))
    lines.push(`${PRODUCT_NAME} no longer reads from .claude/ or CLAUDE.md by default.`)
    lines.push('You can safely remove the old .claude/ directory and CLAUDE.md after verifying the migration.')

    return lines.join('\n')
  },
} satisfies Command

export default migrate
