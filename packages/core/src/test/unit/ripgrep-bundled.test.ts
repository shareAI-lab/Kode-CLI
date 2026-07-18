import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  getRipgrepPath,
  resetRipgrepPathCacheForTests,
  setKodeRipgrepPackageLoaderForTests,
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
  setKodeRipgrepPackageLoaderForTests(null)
  resetRipgrepPathCacheForTests()
})

afterEach(() => {
  restoreEnv()
  setKodeRipgrepPackageLoaderForTests(null)
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

function expectSamePath(actual: string, expected: string): void {
  if (process.platform === 'win32') {
    expect(actual.toLowerCase()).toBe(expected.toLowerCase())
    return
  }
  expect(actual).toBe(expected)
}

test('uses KODE_RIPGREP_PATH when set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kode-rg-path-'))
  try {
    const fakeRg = join(dir, getPlatformExecutableName())
    writeExecutableStub(fakeRg)

    setEnv({ KODE_RIPGREP_PATH: fakeRg })
    expectSamePath(getRipgrepPath(), fakeRg)
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

    expectSamePath(getRipgrepPath(), vendorRg)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('prefers packaged ripgrep optionalDependency when present (default)', () => {
  const root = mkdtempSync(join(tmpdir(), 'kode-rg-packaged-first-'))

  try {
    const binName = getPlatformExecutableName()
    const binDir = join(root, 'bin')
    const binPath = join(binDir, binName)
    mkdirSync(binDir, { recursive: true })
    writeExecutableStub(binPath)

    const expectedPackageName = `@shareai-lab/kode-ripgrep-${process.platform}-${process.arch}`
    setKodeRipgrepPackageLoaderForTests(name => {
      if (name !== expectedPackageName) throw new Error(`Unexpected: ${name}`)
      return { rgPath: binPath }
    })

    setEnv({
      KODE_USE_BUILTIN_RIPGREP: '1',
      PATH: '',
    })

    expectSamePath(getRipgrepPath(), binPath)
  } finally {
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

    expectSamePath(getRipgrepPath(), pathRg)
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

    expectSamePath(getRipgrepPath(), pathRg)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
