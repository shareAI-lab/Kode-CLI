import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export type LinuxSeccompAssets = {
  applySeccompPath: string
  bpfPath: string
}

function getCurrentModuleUrl(): string {
  // CJS builds (for SDK require()) don't have `import.meta.url`.
  // ESM builds don't have `__filename`.
  if (typeof __filename === 'string' && __filename) {
    return pathToFileURL(__filename).href
  }
  return import.meta.url
}

function getLinuxSeccompArch(): 'x64' | 'arm64' | null {
  const arch = process.arch as string
  switch (arch) {
    case 'x64':
    case 'x86_64':
      return 'x64'
    case 'arm64':
    case 'aarch64':
      return 'arm64'
    default:
      return null
  }
}

function resolveBundledSeccompDir(arch: 'x64' | 'arm64'): string | null {
  const startDir = path.dirname(fileURLToPath(getCurrentModuleUrl()))
  let dir = startDir
  for (let i = 0; i < 8; i++) {
    const direct = path.join(dir, 'vendor', 'seccomp', arch)
    if (existsSync(direct)) return direct

    const distVendor = path.join(dir, 'dist', 'vendor', 'seccomp', arch)
    if (existsSync(distVendor)) return distVendor

    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return null
}

export function resolveLinuxSeccompAssets(options?: {
  applySeccompPathOverride?: string | null
  bpfPathOverride?: string | null
}): LinuxSeccompAssets | null {
  const applyOverride =
    options?.applySeccompPathOverride !== undefined
      ? options.applySeccompPathOverride
      : undefined
  const bpfOverride =
    options?.bpfPathOverride !== undefined ? options.bpfPathOverride : undefined

  if (applyOverride !== undefined || bpfOverride !== undefined) {
    if (!applyOverride || !bpfOverride) return null
    if (!existsSync(applyOverride) || !existsSync(bpfOverride)) return null
    return { applySeccompPath: applyOverride, bpfPath: bpfOverride }
  }

  const arch = getLinuxSeccompArch()
  if (!arch) return null

  const seccompDir = resolveBundledSeccompDir(arch)
  if (!seccompDir) return null

  const applySeccompPath = path.join(seccompDir, 'apply-seccomp')
  const bpfPath = path.join(seccompDir, 'unix-block.bpf')
  if (!existsSync(applySeccompPath) || !existsSync(bpfPath)) return null

  return { applySeccompPath, bpfPath }
}
