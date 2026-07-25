import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { logError } from '#core/utils/log'

export function handleHashCommand(interpreted: string): void {
  // Appends the AI-interpreted content to AGENTS.md.
  try {
    const cwd = process.cwd()
    const agentsPath = join(cwd, 'AGENTS.md')

    const now = new Date()
    const timezoneMatch = now.toString().match(/\(([A-Z]+)\)/)
    const timezone = timezoneMatch
      ? timezoneMatch[1]
      : now
            .toLocaleTimeString('en-us', { timeZoneName: 'short' })
            .split(' ')
            .pop()

    const timestamp = interpreted.includes(now.getFullYear().toString())
      ? ''
      : `\n\n_Added on ${now.toLocaleString()} ${timezone}_`

    try {
      let existingContent = ''
      try {
        existingContent = readFileSync(agentsPath, 'utf-8').trim()
      } catch {
        // File doesn't exist yet, that's fine
      }

      const separator = existingContent ? '\n\n' : ''
      const newContent = `${existingContent}${separator}${interpreted}${timestamp}`
      writeFileSync(agentsPath, newContent, 'utf-8')
    } catch (error) {
      logError(error)
    }
  } catch (e) {
    logError(e)
  }
}
