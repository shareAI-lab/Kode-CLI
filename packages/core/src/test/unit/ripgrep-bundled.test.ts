import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  getRipgrepPath,
  resetRipgrepPathCacheForTests,
} from '#core/utils/ripgrep'

const ORIGINAL_ENV = { ...process.env }

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key]
    }
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function setEnv(next: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  resetRipgrepPathCacheForTests()
}

beforeEach(() => {
  restoreEnv()
  resetRipgrepPathCacheForTests()
})

afterEach(() => {
  restoreEnv()
  resetRipgrepPathCacheForTests()
})

function getPlatformExecutableName(): string {
  return process.platform === 'win32' ? 'rg.exe' : 'rg'
}

function writeExecutableStub(filePath: string) {
  if (process.platform === 'win32') {
    writeFileSync(filePath, 'stub')
    return
  }
  writeFileSync(filePath, '#!/bin/sh\n\necho ripgrep\n')
  chmodSync(filePath, 0o755)
}

test('uses KODE_RIPGREP_PATH when set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kode-rg-path-'))
  try {
    const fakeRg = join(dir, getPlatformExecutableName())
    writeExecutableStub(fakeRg)

    setEnv({ KODE_RIPGREP_PATH: fakeRg })
    expect(getRipgrepPath()).toBe(fakeRg)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('prefers bundled ripgrep when available (default)', () => {
  const root = mkdtempSync(join(tmpdir(), 'kode-rg-vendor-first-'))
  try {
    const vendorRoot = join(root, 'vendor', 'ripgrep')
    const vendorDirName =
      process.platform === 'win32'
        ? `${process.arch}-win32`
        : `${process.arch}-${process.platform}`
    const vendorRg = join(
      vendorRoot,
      vendorDirName,
      getPlatformExecutableName(),
    )
    mkdirSync(join(vendorRoot, vendorDirName), { recursive: true })
    writeExecutableStub(vendorRg)

    const pathDir = join(root, 'path')
    mkdirSync(pathDir, { recursive: true })
    const pathRg = join(pathDir, getPlatformExecutableName())
    writeExecutableStub(pathRg)

    const oldPath = process.env.PATH
    const sep = process.platform === 'win32' ? ';' : ':'
    setEnv({
      KODE_RIPGREP_VENDOR_ROOT: vendorRoot,
      PATH: [pathDir, oldPath].filter(Boolean).join(sep),
    })

    expect(getRipgrepPath()).toBe(vendorRg)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('prefers packaged ripgrep optionalDependency when present (default)', () => {
  const root = mkdtempSync(join(tmpdir(), 'kode-rg-packaged-first-'))
  const scopeDir = join(process.cwd(), 'node_modules', '@shareai-lab')
  const pkgName = `kode-ripgrep-${process.platform}-${process.arch}`
  const pkgDir = join(scopeDir, pkgName)

  // In a Bun workspace this package is a SYMLINK to packages/kode-ripgrep-*,
  // so writing here would modify a git-tracked source file. Snapshot whatever
  // we touch and put it back, and never delete a directory we did not create.
  let realPkgDir = pkgDir
  try {
    realPkgDir = realpathSync(pkgDir)
  } catch {
    // package not installed: the path below simply won't exist until we make it
  }
  const pkgDirExisted = existsSync(realPkgDir)
  const indexPath = join(realPkgDir, 'index.js')
  const originalIndex = existsSync(indexPath)
    ? readFileSync(indexPath, 'utf8')
    : null

  const binName = getPlatformExecutableName()
  const binDir = join(realPkgDir, 'bin')
  const binPath = join(binDir, binName)
  const originalBin = existsSync(binPath) ? readFileSync(binPath) : null

  try {
    mkdirSync(binDir, { recursive: true })
    writeExecutableStub(binPath)

    const indexJs = [
      "const path = require('node:path')",
      '',
      'module.exports = {',
      `  rgPath: path.join(__dirname, 'bin', ${JSON.stringify(binName)}),`,
      '}',
      '',
    ].join('\n')
    writeFileSync(indexPath, indexJs)

    setEnv({
      KODE_USE_BUILTIN_RIPGREP: '1',
      PATH: '',
    })

    expect(getRipgrepPath()).toBe(binPath)
  } finally {
    // Restore every file we overwrote; only remove what we created.
    try {
      if (originalIndex !== null) writeFileSync(indexPath, originalIndex)
      else rmSync(indexPath, { force: true })
    } catch {}

    try {
      if (originalBin !== null) writeFileSync(binPath, originalBin)
      else rmSync(binPath, { force: true })
    } catch {}

    if (!pkgDirExisted) {
      try {
        rmSync(realPkgDir, { recursive: true, force: true })
      } catch {}
    }

    rmSync(root, { recursive: true, force: true })
  }
})

test('uses rg found on PATH when builtin is disabled (USE_BUILTIN_RIPGREP=0)', () => {
  const root = mkdtempSync(join(tmpdir(), 'kode-rg-path-only-'))
  try {
    const vendorRoot = join(root, 'vendor', 'ripgrep')
    const vendorDirName =
      process.platform === 'win32'
        ? `${process.arch}-win32`
        : `${process.arch}-${process.platform}`
    const vendorRg = join(
      vendorRoot,
      vendorDirName,
      getPlatformExecutableName(),
    )
    mkdirSync(join(vendorRoot, vendorDirName), { recursive: true })
    writeExecutableStub(vendorRg)

    const pathDir = join(root, 'path')
    mkdirSync(pathDir, { recursive: true })
    const pathRg = join(pathDir, getPlatformExecutableName())
    writeExecutableStub(pathRg)

    const oldPath = process.env.PATH
    const sep = process.platform === 'win32' ? ';' : ':'
    setEnv({
      KODE_RIPGREP_VENDOR_ROOT: vendorRoot,
      USE_BUILTIN_RIPGREP: '0',
      PATH: [pathDir, oldPath].filter(Boolean).join(sep),
    })

    expect(getRipgrepPath()).toBe(pathRg)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('falls back to rg found on PATH when vendor is unavailable', () => {
  const root = mkdtempSync(join(tmpdir(), 'kode-rg-path-fallback-'))
  try {
    const pathDir = join(root, 'path')
    mkdirSync(pathDir, { recursive: true })
    const pathRg = join(pathDir, getPlatformExecutableName())
    writeExecutableStub(pathRg)

    const oldPath = process.env.PATH
    const sep = process.platform === 'win32' ? ';' : ':'
    setEnv({
      KODE_RIPGREP_VENDOR_ROOT: join(root, 'missing-vendor'),
      PATH: [pathDir, oldPath].filter(Boolean).join(sep),
    })

    expect(getRipgrepPath()).toBe(pathRg)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
