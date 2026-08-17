'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

/**
 * 尝试从 optionalDeps 解析原生二进制文件
 * @returns {string|null} 原生二进制路径或 null
 */
function tryResolveNativeBinary() {
  const platform = process.platform
  const arch = process.arch

  const candidates = [`@shareai-lab/kode-bin-${platform}-${arch}`]

  // Windows ARM64 可以通过仿真运行 x64 二进制
  if (platform === 'win32' && arch === 'arm64') {
    candidates.push('@shareai-lab/kode-bin-win32-x64')
  }

  for (const pkgName of candidates) {
    try {
      const mod = require(pkgName)
      const binPath = mod?.kodePath
      if (typeof binPath === 'string' && fs.existsSync(binPath)) {
        return binPath
      }
    } catch {
      // optionalDeps 可能未安装
    }
  }

  return null
}

/**
 * 查找包根目录
 * @param {string} startDir 起始目录
 * @returns {string} 包根目录
 */
function findPackageRoot(startDir) {
  let dir = startDir
  for (let i = 0; i < 25; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return startDir
}

/**
 * 读取 package.json
 * @param {string} packageRoot 包根目录
 * @returns {object|null} package.json 内容
 */
function readPackageJson(packageRoot) {
  try {
    const p = path.join(packageRoot, 'package.json')
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 检查命令行参数中是否存在指定标志
 * @param {string} flag 标志名称
 * @returns {boolean}
 */
function hasFlag(flag) {
  return process.argv.includes(flag)
}

/**
 * 同步执行命令
 * @param {string} cmd 命令
 * @param {string[]} args 参数
 * @param {object} [options] 额外选项
 * @returns {void}
 */
function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    env: {
      ...process.env,
      KODE_PACKAGED: process.env.KODE_PACKAGED || '1',
      ...options.env,
    },
  })

  if (result.error) {
    throw result.error
  }

  process.exit(typeof result.status === 'number' ? result.status : 1)
}

/**
 * 输出错误信息并退出
 * @param {string} title 错误标题
 * @param {string[]} fixes 修复建议
 * @param {string} [version] 版本号
 */
function fatal(title, fixes, version = '') {
  const lines = [
    `❌ ${title}`,
    '',
    'Tried:',
    '- Native binary (optionalDependencies)',
    '- Node.js runtime fallback',
    '',
    'Fix:',
    ...fixes,
  ]

  if (version) {
    lines.push('', `Package version: ${version}`)
  }

  process.stderr.write(lines.filter(Boolean).join('\n'))
  process.exit(1)
}

/**
 * 通用 CLI 启动器
 * @param {string} cliName CLI 名称（用于错误信息）
 * @param {string[]} extraArgs 额外参数
 * @param {object} [options] 选项
 */
function launchCli(cliName, extraArgs = [], options = {}) {
  const packageRoot = findPackageRoot(__dirname)
  const pkg = readPackageJson(packageRoot)
  const version = pkg?.version || ''

  // 尝试原生二进制
  const nativeBin = tryResolveNativeBinary()
  if (nativeBin) {
    run(nativeBin, [...extraArgs, ...process.argv.slice(2)], options)
  }

  // Node.js 运行时回退
  const distEntry = path.join(packageRoot, 'dist', 'index.js')
  if (fs.existsSync(distEntry)) {
    run(
      process.execPath,
      [distEntry, ...extraArgs, ...process.argv.slice(2)],
      options,
    )
  }

  // 最终错误
  fatal(
    `${cliName} is not runnable on this system.`,
    [
      '- Reinstall with optionalDependencies enabled (avoid --no-optional/--omit=optional)',
      '- Or install a platform binary package: @shareai-lab/kode-bin-<platform>-<arch>',
      '- Or reinstall and ensure dist/ is present (npm install -g @shareai-lab/kode)',
      '- Or run from source: bun run dev',
    ],
    version,
  )
}

module.exports = {
  tryResolveNativeBinary,
  findPackageRoot,
  readPackageJson,
  hasFlag,
  run,
  fatal,
  launchCli,
}
