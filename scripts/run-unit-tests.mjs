import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const repoRoot = process.cwd()
const unitTestRoots = [
  'packages/core/src/test/unit',
  'apps/cli/src',
  'packages/config/src/test/unit',
  'packages/host/src/test/unit',
  'packages/protocol/src/test/unit',
  'packages/runtime/src/test/unit',
]
const testPatterns = [
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/*.spec.ts',
  '**/*.spec.tsx',
]
const coveragePathExclusions = ['apps/cli/src/ui/']
const runCoverage = process.argv.slice(2).includes('--coverage')

if (process.argv.slice(2).some(argument => argument !== '--coverage')) {
  throw new Error('Usage: bun run scripts/run-unit-tests.mjs [--coverage]')
}

function isEnabledEnvironmentFlag(value) {
  return value !== undefined && value !== '0' && value !== 'false'
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function coverageThreshold() {
  const parsed = Number(process.env.KODE_UNIT_COVERAGE_THRESHOLD ?? '50')
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error('KODE_UNIT_COVERAGE_THRESHOLD must be between 0 and 100.')
  }
  return parsed
}

function isMeasuredCoverageSource(file) {
  return !coveragePathExclusions.some(prefix => file.startsWith(prefix))
}

async function discoverTestFiles() {
  const files = new Set()
  for (const root of unitTestRoots) {
    for (const pattern of testPatterns) {
      const glob = new Bun.Glob(`${root}/${pattern}`)
      for await (const relative of glob.scan(repoRoot)) files.add(relative)
    }
  }
  return Array.from(files).sort()
}

function boundedOutput(value, maxLength = 40_000) {
  if (value.length <= maxLength) return value
  const half = Math.floor(maxLength / 2)
  return `${value.slice(0, half)}\n... output truncated ...\n${value.slice(-half)}`
}

function mergeLcov(linesByFile, source) {
  let file = null
  for (const line of source.split('\n')) {
    if (line.startsWith('SF:')) {
      file = line.slice(3)
      if (!linesByFile.has(file)) linesByFile.set(file, new Map())
      continue
    }
    if (!file || !line.startsWith('DA:')) continue
    const [lineNumber, hits] = line.slice(3).split(',', 2).map(Number)
    if (!Number.isInteger(lineNumber) || !Number.isFinite(hits)) continue
    const lines = linesByFile.get(file)
    lines.set(lineNumber, Math.max(lines.get(lineNumber) ?? 0, hits))
  }
}

async function runTestFile({
  relative,
  index,
  coverageDirectory,
  testEnvironment,
  linesByFile,
}) {
  const startedAt = performance.now()
  const outputDirectory =
    coverageDirectory && join(coverageDirectory, String(index))
  if (outputDirectory) await mkdir(outputDirectory, { recursive: true })
  const command = [process.execPath, 'test']
  if (outputDirectory) {
    command.push(
      '--coverage',
      '--coverage-reporter=lcov',
      `--coverage-dir=${outputDirectory}`,
    )
  }
  command.push(`./${relative}`)
  const child = Bun.spawn(command, {
    cwd: repoRoot,
    env: testEnvironment,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode === 0 && outputDirectory) {
    try {
      mergeLcov(
        linesByFile,
        await readFile(join(outputDirectory, 'lcov.info'), 'utf8'),
      )
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return {
          relative,
          exitCode,
          stdout,
          stderr,
          durationMs: Math.round(performance.now() - startedAt),
        }
      }
      return {
        relative,
        exitCode: 1,
        stdout,
        stderr: `${stderr}\nCoverage report could not be read: ${error}`,
        durationMs: Math.round(performance.now() - startedAt),
      }
    }
  }
  return {
    relative,
    exitCode,
    stdout,
    stderr,
    durationMs: Math.round(performance.now() - startedAt),
  }
}

const testFiles = await discoverTestFiles()
if (testFiles.length === 0) throw new Error('No unit test files found.')

const isCI =
  isEnabledEnvironmentFlag(process.env.CI) ||
  isEnabledEnvironmentFlag(process.env.CONTINUOUS_INTEGRATION)
const testEnvironment = { ...process.env }
if (isCI) {
  // Keep CI-specific application behavior while allowing Ink harnesses to
  // render intermediate frames in their isolated test processes.
  testEnvironment.CI = 'false'
  testEnvironment.CONTINUOUS_INTEGRATION = 'false'
}
const defaultConcurrency = isCI ? 1 : Math.min(4, availableParallelism())
const concurrency = Math.min(
  testFiles.length,
  positiveInteger(process.env.KODE_TEST_CONCURRENCY, defaultConcurrency),
)
const linesByFile = new Map()
const coverageDirectory = runCoverage
  ? await mkdtemp(join(tmpdir(), 'kode-unit-coverage-'))
  : null
const results = new Array(testFiles.length)
let nextIndex = 0

process.stdout.write(
  `Running ${testFiles.length} unit test files with concurrency=${concurrency}${runCoverage ? ' and isolated coverage' : ''}\n`,
)

async function worker() {
  while (true) {
    const index = nextIndex++
    if (index >= testFiles.length) return
    const result = await runTestFile({
      relative: testFiles[index],
      index,
      coverageDirectory,
      testEnvironment,
      linesByFile,
    })
    results[index] = result
    process.stdout.write(
      `[${String(index + 1).padStart(String(testFiles.length).length, '0')}/${testFiles.length}] ${result.exitCode === 0 ? 'PASS' : 'FAIL'} ${result.relative} (${result.durationMs}ms)\n`,
    )
  }
}

try {
  await Promise.all(Array.from({ length: concurrency }, () => worker()))

  const failures = results.filter(result => result.exitCode !== 0)
  for (const failure of failures) {
    process.stderr.write(
      `\n--- ${failure.relative}: exited with code ${failure.exitCode} ---\n`,
    )
    if (failure.stdout) process.stderr.write(boundedOutput(failure.stdout))
    if (failure.stderr) process.stderr.write(boundedOutput(failure.stderr))
    process.stderr.write('\n')
  }

  if (runCoverage) {
    let totalLines = 0
    let coveredLines = 0
    const coverageByFile = []
    for (const [file, lines] of linesByFile) {
      if (!isMeasuredCoverageSource(file)) continue
      let fileCoveredLines = 0
      for (const hits of lines.values()) {
        totalLines += 1
        if (hits > 0) {
          coveredLines += 1
          fileCoveredLines += 1
        }
      }
      coverageByFile.push({
        file,
        totalLines: lines.size,
        coveredLines: fileCoveredLines,
      })
    }
    const percentage = totalLines === 0 ? 0 : (coveredLines / totalLines) * 100
    const threshold = coverageThreshold()
    process.stdout.write(
      `Line coverage: ${percentage.toFixed(2)}% (${coveredLines}/${totalLines}), threshold: ${threshold.toFixed(2)}%\n`,
    )
    process.stdout.write(
      `Excluded from coverage metric: ${coveragePathExclusions.join(', ')} (covered by isolated UI assertions in the Test step)\n`,
    )
    const largestGaps = coverageByFile
      .sort(
        (left, right) =>
          right.totalLines -
            right.coveredLines -
            (left.totalLines - left.coveredLines) ||
          right.totalLines - left.totalLines,
      )
      .slice(0, 20)
    if (largestGaps.length > 0) {
      process.stdout.write('Largest uncovered source files:\n')
      for (const gap of largestGaps) {
        process.stdout.write(
          `  ${gap.file}: ${gap.coveredLines}/${gap.totalLines}\n`,
        )
      }
    }
    if (percentage < threshold) {
      failures.push({
        relative: 'coverage threshold',
        exitCode: 1,
        stdout: '',
        stderr: `Line coverage ${percentage.toFixed(2)}% is below ${threshold.toFixed(2)}%.`,
      })
    }
  }

  process.stdout.write(
    `\nUnit test summary: ${results.length - failures.length} passed files, ${failures.length} failed files\n`,
  )
  if (failures.length > 0) process.exitCode = 1
} finally {
  if (coverageDirectory) {
    await rm(coverageDirectory, { recursive: true, force: true })
  }
}
