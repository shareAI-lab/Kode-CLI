import { appendFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import chalk from 'chalk'

import { getKodeAgentSessionId } from '#protocol/utils/kodeAgentSessionId'

import { debug, getCurrentRequest } from './logger'
import { isDebugMode, isDebugVerboseMode, isVerboseMode } from './mode'
import { terminalLog } from './terminal'
import { getKodeDir } from './transports'

export function logAPIError(context: {
  model: string
  endpoint: string
  status: number
  error: any
  request?: any
  response?: any
  provider?: string
}) {
  const errorDir = join(getKodeDir(), 'logs', 'error', 'api')

  if (!existsSync(errorDir)) {
    try {
      mkdirSync(errorDir, { recursive: true })
    } catch (err) {
      terminalLog('Failed to create error log directory:', err)
      return
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const sanitizedModel = context.model.replace(/[^a-zA-Z0-9-_]/g, '_')
  const filename = `${sanitizedModel}_${timestamp}.log`
  const filepath = join(errorDir, filename)

  const fullLogContent = {
    timestamp: new Date().toISOString(),
    sessionId: getKodeAgentSessionId(),
    requestId: getCurrentRequest()?.id,
    model: context.model,
    provider: context.provider,
    endpoint: context.endpoint,
    status: context.status,
    error: context.error,
    request: context.request,
    response: context.response,
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      cwd: process.cwd(),
    },
  }

  try {
    appendFileSync(filepath, JSON.stringify(fullLogContent, null, 2) + '\n')
    appendFileSync(filepath, '='.repeat(80) + '\n\n')
  } catch (err) {
    terminalLog('Failed to write API error log:', err)
  }

  if (isDebugMode()) {
    debug.error('API_ERROR', {
      model: context.model,
      status: context.status,
      error:
        typeof context.error === 'string'
          ? context.error
          : context.error?.message || 'Unknown error',
      endpoint: context.endpoint,
      logFile: filename,
    })
  }

  if (isVerboseMode() || isDebugVerboseMode()) {
    terminalLog()
    terminalLog(chalk.red('━'.repeat(60)))
    terminalLog(chalk.red.bold('⚠️  API Error'))
    terminalLog(chalk.red('━'.repeat(60)))

    terminalLog(chalk.white('  Model:  ') + chalk.yellow(context.model))
    terminalLog(chalk.white('  Status: ') + chalk.red(context.status))

    let errorMessage = 'Unknown error'
    if (typeof context.error === 'string') {
      errorMessage = context.error
    } else if (context.error?.message) {
      errorMessage = context.error.message
    } else if (context.error?.error?.message) {
      errorMessage = context.error.error.message
    }

    terminalLog(chalk.white('  Error:  ') + chalk.red(errorMessage))

    if (context.response) {
      terminalLog()
      terminalLog(chalk.gray('  Response:'))
      const responseStr =
        typeof context.response === 'string'
          ? context.response
          : JSON.stringify(context.response, null, 2)

      responseStr.split('\n').forEach(line => {
        terminalLog(chalk.gray('    ' + line))
      })
    }

    terminalLog()
    terminalLog(chalk.dim(`  📁 Full log: ${filepath}`))
    terminalLog(chalk.red('━'.repeat(60)))
    terminalLog()
  }
}
