import path from 'node:path'
import { availableParallelism } from 'node:os'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)
const testPatterns = [
  'apps/**/*.test.ts',
  'apps/**/*.test.tsx',
  'apps/**/*.spec.ts',
  'apps/**/*.spec.tsx',
  'packages/**/*.test.ts',
  'packages/**/*.test.tsx',
  'packages/**/*.spec.ts',
  'packages/**/*.spec.tsx',
]
const testFilePattern = /^(?:apps|packages)\/.+\.(?:test|spec)\.tsx?$/

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function normalizeRequestedFile(filePath) {
  const resolved = path.resolve(repoRoot, filePath)
  const relative = path.relative(repoRoot, resolved).replaceAll(path.sep, '/')
  if (
    relative.startsWith('../') ||
    path.isAbsolute(relative) ||
    !testFilePattern.test(relative)
  ) {
    throw new Error(
      `Test file is outside the workspace test scope: ${filePath}`,
    )
  }
  return relative
}

async function discoverTestFiles() {
  const files = new Set()
  for (const pattern of testPatterns) {
    const glob = new Bun.Glob(pattern)
    for await (const relative of glob.scan(repoRoot)) files.add(relative)
  }
  return Array.from(files).sort()
}

function boundedOutput(value, maxLength = 40_000) {
  if (value.length <= maxLength) return value
  const half = Math.floor(maxLength / 2)
  return `${value.slice(0, half)}\n... output truncated ...\n${value.slice(-half)}`
}

async function runTestFile(relative, fileTimeoutMs) {
  const startedAt = performance.now()
  const child = Bun.spawn([process.execPath, 'test', `./${relative}`], {
    cwd: repoRoot,
    env: process.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    try {
      child.kill()
    } catch {}
  }, fileTimeoutMs)

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(timeout)

  const output = `${stdout}\n${stderr}`
  const hasSummary = /Ran \d+ tests? across \d+ files?\./.test(output)
  const passed = !timedOut && exitCode === 0 && hasSummary

  return {
    relative,
    passed,
    timedOut,
    exitCode,
    hasSummary,
    durationMs: Math.round(performance.now() - startedAt),
    stdout,
    stderr,
  }
}

const requestedFiles = process.argv.slice(2)
const testFiles =
  requestedFiles.length > 0
    ? Array.from(new Set(requestedFiles.map(normalizeRequestedFile))).sort()
    : await discoverTestFiles()

if (testFiles.length === 0) throw new Error('No workspace test files found')

const concurrency = Math.min(
  testFiles.length,
  positiveInteger(
    process.env.KODE_TEST_CONCURRENCY,
    Math.min(4, availableParallelism()),
  ),
)
const fileTimeoutMs = positiveInteger(
  process.env.KODE_TEST_FILE_TIMEOUT_MS,
  120_000,
)
const startedAt = performance.now()
const results = new Array(testFiles.length)
let nextIndex = 0

process.stdout.write(
  `Running ${testFiles.length} workspace test files with concurrency=${concurrency}\n`,
)

async function worker() {
  while (true) {
    const index = nextIndex++
    if (index >= testFiles.length) return
    const result = await runTestFile(testFiles[index], fileTimeoutMs)
    results[index] = result
    const status = result.passed ? 'PASS' : 'FAIL'
    process.stdout.write(
      `[${String(index + 1).padStart(String(testFiles.length).length, '0')}/${testFiles.length}] ${status} ${result.relative} (${result.durationMs}ms)\n`,
    )
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()))

const failures = results.filter(result => !result.passed)
for (const failure of failures) {
  const reason = failure.timedOut
    ? `timed out after ${fileTimeoutMs}ms`
    : failure.exitCode === 0 && !failure.hasSummary
      ? 'exited without a Bun test summary'
      : `exited with code ${failure.exitCode}`
  process.stderr.write(`\n--- ${failure.relative}: ${reason} ---\n`)
  if (failure.stdout) process.stderr.write(boundedOutput(failure.stdout))
  if (failure.stderr) process.stderr.write(boundedOutput(failure.stderr))
  process.stderr.write('\n')
}

const durationMs = Math.round(performance.now() - startedAt)
process.stdout.write(
  `\nWorkspace test summary: ${results.length - failures.length} passed files, ${failures.length} failed files, ${durationMs}ms\n`,
)

if (failures.length > 0) process.exitCode = 1
