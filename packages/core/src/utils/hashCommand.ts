import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { logError } from '#core/utils/log'

export const HASH_COMMAND_SAVE_FAILURE_MESSAGE =
  'Unable to save the note to AGENTS.md. Check the file path and permissions, then retry.'

export function handleHashCommand(interpreted: string): boolean {
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

    let existingContent = ''
    try {
      existingContent = readFileSync(agentsPath, 'utf-8').trim()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
      // The file does not exist yet, so create it below.
    }

    const separator = existingContent ? '\n\n' : ''
    const newContent = `${existingContent}${separator}${interpreted}${timestamp}`
    writeFileSync(agentsPath, newContent, 'utf-8')
    return true
  } catch (e) {
    logError(e)
    return false
  }
}
