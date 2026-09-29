// Aggregates workspace tests so `bun test` from the repository root has one
// explicit and deterministic discovery surface.

// Must run before any test file is imported: Ink reads CI detection at import
// time and would otherwise render nothing for the frame-asserting TUI tests.
// Static imports execute before the dynamic import() calls below, so this is
// guaranteed regardless of bunfig `preload` support.
import '../scripts/test-preload'

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Files that call `mock.module()` are run in their own process.
 *
 * `mock.module` replaces a module in bun's registry for the whole process and
 * `mock.restore()` does NOT undo that for modules other test files import
 * afterwards (verified: a later file saw the mock's value). Importing every
 * file into one process therefore let one suite silently rewrite another
 * suite's dependencies — e.g. mocking `#core/ai/llm` broke two
 * `queryLLM`-related suites that run later.
 *
 * Isolating these files fixes both directions: they cannot pollute others, and
 * they cannot be polluted by others.
 */
function usesModuleMocking(absPath: string): boolean {
  try {
    return readFileSync(absPath, 'utf8').includes('mock.module')
  } catch {
    return false
  }
}

async function collectTestFiles(repoRoot: string): Promise<string[]> {
  const patterns = [
    'apps/**/*.test.ts',
    'apps/**/*.test.tsx',
    'apps/**/*.spec.ts',
    'apps/**/*.spec.tsx',
    'packages/**/*.test.ts',
    'packages/**/*.test.tsx',
    'packages/**/*.spec.ts',
    'packages/**/*.spec.tsx',
  ]

  const files = new Set<string>()
  for (const pattern of patterns) {
    const glob = new Bun.Glob(pattern)
    for await (const relPath of glob.scan(repoRoot)) {
      files.add(relPath)
    }
  }

  return Array.from(files).sort()
}

/** Run one test file in a child process; returns false when it reports failures. */
async function runIsolatedTestFile(relPath: string): Promise<boolean> {
  process.stdout.write(`\n${relPath} (isolated process):\n`)
  const proc = Bun.spawn(['bun', 'test', `./${relPath}`], {
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'ignore',
  })
  const exitCode = await proc.exited
  return exitCode === 0
}

async function importWorkspaceTests(): Promise<void> {
  const thisDir = resolve(fileURLToPath(new URL('.', import.meta.url)))
  const repoRoot = resolve(thisDir, '..')

  const sorted = await collectTestFiles(repoRoot)

  const isolated: string[] = []
  for (const relPath of sorted) {
    const absPath = resolve(repoRoot, relPath)
    if (usesModuleMocking(absPath)) {
      isolated.push(relPath)
      continue
    }
    await import(pathToFileURL(absPath).href)
  }

  if (isolated.length === 0) return

  const failures: string[] = []
  for (const relPath of isolated) {
    const ok = await runIsolatedTestFile(relPath)
    if (!ok) failures.push(relPath)
  }

  if (failures.length > 0) {
    console.error(
      `\nIsolated test files failed (${failures.length}):\n` +
        failures.map(file => `- ${file}`).join('\n'),
    )
    // Fail the aggregated run; the child already printed the details.
    process.exit(1)
  }
}

await importWorkspaceTests()
