import { spawn } from 'node:child_process'

export type CodexLoginStatus =
  | { kind: 'authenticated' }
  | { kind: 'unauthenticated' }
  | { kind: 'unavailable' }

export type CodexRecommendedSettings = {
  model: string
  displayName: string
  reasoningEffort: string
}

export type CodexAuthService = {
  getStatus(): Promise<CodexLoginStatus>
  startLogin(): Promise<void>
  getAvailableModels?: () => Promise<CodexRecommendedSettings[]>
  getRecommendedSettings(): Promise<CodexRecommendedSettings>
  applyRecommendedSettings(settings: CodexRecommendedSettings): Promise<void>
}

type CodexCommandResult = {
  exitCode: number | null
  stdout: string
  stderr: string
}

const STATUS_TIMEOUT_MS = 10_000
const APP_SERVER_TIMEOUT_MS = 10_000
const APP_SERVER_MAX_OUTPUT_BYTES = 1024 * 1024
const APP_SERVER_INITIALIZE_REQUEST_ID = 1
const APP_SERVER_OPERATION_REQUEST_ID = 2

type JsonRpcError = {
  code?: unknown
  message?: unknown
}

type JsonRpcResponse = {
  id?: unknown
  result?: unknown
  error?: JsonRpcError
}

type CodexAppServerRequest = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>

function getCodexCommand(): string {
  return process.platform === 'win32' ? 'codex.cmd' : 'codex'
}

function usesWindowsShell(): boolean {
  return process.platform === 'win32'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function writeJsonLine(
  child: ReturnType<typeof spawn>,
  message: Record<string, unknown>,
): void {
  if (!child.stdin || child.stdin.destroyed) {
    throw new Error('Codex app-server input is unavailable')
  }
  child.stdin.write(`${JSON.stringify(message)}\n`)
}

/**
 * Ask Codex to read or mutate its own configuration through its typed local
 * protocol. Kode never opens Codex's OAuth credential store.
 */
function runCodexAppServerRequest(
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(getCodexCommand(), ['app-server', '--stdio'], {
      shell: usesWindowsShell(),
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    })

    let settled = false
    let initialized = false
    let stdoutBuffer = ''
    let stdoutBytes = 0

    const finish = (error?: Error, result?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (!child.killed) child.kill()
      if (error) reject(error)
      else resolve(result)
    }

    const fail = () => finish(new Error('Codex app-server request failed'))
    const timeout = setTimeout(fail, APP_SERVER_TIMEOUT_MS)

    child.once('error', fail)
    child.once('close', () => {
      if (!settled) fail()
    })
    child.stdin?.once('error', fail)

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', chunk => {
      if (settled) return
      stdoutBytes += Buffer.byteLength(chunk)
      if (stdoutBytes > APP_SERVER_MAX_OUTPUT_BYTES) {
        fail()
        return
      }

      stdoutBuffer += chunk
      for (;;) {
        const newlineIndex = stdoutBuffer.indexOf('\n')
        if (newlineIndex < 0) break

        const line = stdoutBuffer.slice(0, newlineIndex).trim()
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
        if (!line) continue

        let message: JsonRpcResponse
        try {
          const parsed: unknown = JSON.parse(line)
          if (!isRecord(parsed)) {
            fail()
            return
          }
          message = parsed
        } catch {
          fail()
          return
        }

        if (message.id === APP_SERVER_INITIALIZE_REQUEST_ID) {
          if (message.error || initialized) {
            fail()
            return
          }
          initialized = true
          try {
            writeJsonLine(child, { method: 'initialized', params: {} })
            writeJsonLine(child, {
              id: APP_SERVER_OPERATION_REQUEST_ID,
              method,
              params,
            })
          } catch {
            fail()
          }
          continue
        }

        if (message.id === APP_SERVER_OPERATION_REQUEST_ID) {
          if (message.error || !initialized) {
            fail()
            return
          }
          finish(undefined, message.result)
          return
        }
      }
    })

    try {
      writeJsonLine(child, {
        id: APP_SERVER_INITIALIZE_REQUEST_ID,
        method: 'initialize',
        params: {
          clientInfo: {
            name: 'kode-cli',
            title: 'Kode CLI',
            version: process.env.npm_package_version || 'unknown',
          },
          capabilities: {
            experimentalApi: false,
            requestAttestation: false,
          },
        },
      })
    } catch {
      fail()
    }
  })
}

function isSafeCodexSetting(
  value: unknown,
  maxLength: number,
): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value)
  )
}

function parseRecommendedModel(
  value: unknown,
): CodexRecommendedSettings | null {
  if (!isRecord(value) || !isSafeCodexSetting(value.model, 128)) return null

  const reasoningOptions = Array.isArray(value.supportedReasoningEfforts)
    ? value.supportedReasoningEfforts
        .map(option =>
          isRecord(option) && isSafeCodexSetting(option.reasoningEffort, 32)
            ? option.reasoningEffort
            : null,
        )
        .filter((effort): effort is string => Boolean(effort))
    : []
  const defaultReasoningEffort = isSafeCodexSetting(
    value.defaultReasoningEffort,
    32,
  )
    ? value.defaultReasoningEffort
    : null
  const reasoningEffort =
    defaultReasoningEffort &&
    (reasoningOptions.length === 0 ||
      reasoningOptions.includes(defaultReasoningEffort))
      ? defaultReasoningEffort
      : reasoningOptions.includes('medium')
        ? 'medium'
        : reasoningOptions[0]

  if (!reasoningEffort) return null

  const displayName =
    typeof value.displayName === 'string' &&
    value.displayName.length > 0 &&
    value.displayName.length <= 120 &&
    !/[\u0000-\u001f\u007f]/.test(value.displayName)
      ? value.displayName
      : value.model

  return {
    model: value.model,
    displayName,
    reasoningEffort,
  }
}

export function selectCodexModels(result: unknown): CodexRecommendedSettings[] {
  if (!isRecord(result) || !Array.isArray(result.data)) {
    throw new Error('Codex did not return a model catalog')
  }

  const models = result.data
    .map(model => ({
      settings: parseRecommendedModel(model),
      isDefault: isRecord(model) && model.isDefault === true,
    }))
    .filter(
      (
        candidate,
      ): candidate is {
        settings: CodexRecommendedSettings
        isDefault: boolean
      } => candidate.settings !== null,
    )

  const defaultModel = models.find(candidate => candidate.isDefault)?.settings
  const availableModels = [
    ...(defaultModel ? [defaultModel] : []),
    ...models
      .map(candidate => candidate.settings)
      .filter(model => model.model !== defaultModel?.model),
  ]
  if (availableModels.length === 0) {
    throw new Error('Codex did not return a usable recommended model')
  }
  return availableModels
}

export function selectCodexRecommendedSettings(
  result: unknown,
): CodexRecommendedSettings {
  return selectCodexModels(result)[0]!
}

function validateRecommendedSettings(
  settings: CodexRecommendedSettings,
): CodexRecommendedSettings {
  if (
    !isSafeCodexSetting(settings.model, 128) ||
    !isSafeCodexSetting(settings.reasoningEffort, 32)
  ) {
    throw new Error('Invalid Codex recommended settings')
  }
  return settings
}

export function createCodexAuthService(
  request: CodexAppServerRequest = runCodexAppServerRequest,
): CodexAuthService {
  return {
    getStatus: getCodexLoginStatus,
    startLogin: startCodexLogin,
    async getAvailableModels() {
      const result = await request('model/list', {
        limit: 100,
        includeHidden: false,
      })
      return selectCodexModels(result)
    },
    async getRecommendedSettings() {
      const result = await request('model/list', {
        limit: 100,
        includeHidden: false,
      })
      return selectCodexRecommendedSettings(result)
    },
    async applyRecommendedSettings(settings) {
      const recommended = validateRecommendedSettings(settings)
      const result = await request('config/batchWrite', {
        edits: [
          {
            keyPath: 'model',
            value: recommended.model,
            mergeStrategy: 'replace',
          },
          {
            keyPath: 'model_reasoning_effort',
            value: recommended.reasoningEffort,
            mergeStrategy: 'replace',
          },
        ],
        reloadUserConfig: false,
      })
      if (!isRecord(result) || result.status !== 'ok') {
        throw new Error('Codex did not apply the recommended settings')
      }
    },
  }
}

function runCodexStatus(): Promise<CodexCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(getCodexCommand(), ['login', 'status'], {
      shell: usesWindowsShell(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill()
    }, STATUS_TIMEOUT_MS)

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', chunk => {
      stdout += chunk
    })
    child.stderr?.on('data', chunk => {
      stderr += chunk
    })
    child.once('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('close', exitCode => {
      clearTimeout(timeout)
      if (timedOut) {
        reject(new Error('Timed out while checking Codex login status'))
        return
      }
      resolve({ exitCode, stdout, stderr })
    })
  })
}

export function parseCodexLoginStatus(
  result: CodexCommandResult,
): CodexLoginStatus {
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase()

  if (
    output.includes('not logged in') ||
    output.includes('not authenticated') ||
    output.includes('no login')
  ) {
    return { kind: 'unauthenticated' }
  }

  if (result.exitCode === 0 && output.includes('logged in')) {
    return { kind: 'authenticated' }
  }

  return { kind: 'unavailable' }
}

export async function getCodexLoginStatus(): Promise<CodexLoginStatus> {
  try {
    return parseCodexLoginStatus(await runCodexStatus())
  } catch {
    return { kind: 'unavailable' }
  }
}

/**
 * Start the official Codex browser login without reading or copying its
 * credential cache. The detached process owns the browser callback and writes
 * credentials only through the Codex CLI's normal storage mechanism.
 */
export function startCodexLogin(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(getCodexCommand(), ['login'], {
      detached: true,
      shell: usesWindowsShell(),
      stdio: 'ignore',
      windowsHide: true,
    })

    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

export const codexAuthService = createCodexAuthService()
