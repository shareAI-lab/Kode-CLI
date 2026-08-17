import type { Command } from '../types'
import { reloadCustomCommandsForSession } from '#cli-services/customCommands'
import { debug as debugLogger } from '#core/utils/debugLogger'
import { logError } from '#core/utils/log'

/**
 * Refresh Commands - Reload custom commands from filesystem
 *
 * This command provides a runtime mechanism to refresh the custom commands
 * cache without restarting the application. It's particularly useful during
 * development or when users are actively creating/modifying custom commands.
 *
 * The command follows the standard local command pattern used throughout
 * the project and provides detailed feedback about the refresh operation.
 */
function getCommandScope(cmd: Command): 'project' | 'user' | null {
  const scope = (cmd as unknown as Record<string, unknown>).scope
  if (scope === 'project' || scope === 'user') return scope
  return null
}

const refreshCommands = {
  type: 'local',
  name: 'refresh-commands',
  description: 'Reload custom commands from filesystem',
  isEnabled: true,
  isHidden: true,
  async call(_, context) {
    try {
      await reloadCustomCommandsForSession()

      const { getCommands } = await import('../registry')

      // Reload commands to get updated count and validate the refresh
      const commands = await getCommands()
      let projectCommands = 0
      let userCommands = 0
      for (const cmd of commands) {
        const scope = getCommandScope(cmd)
        if (scope === 'project') projectCommands++
        if (scope === 'user') userCommands++
      }
      const customCommandsCount = projectCommands + userCommands

      // Provide detailed feedback about the refresh operation
      return `Commands refreshed.

Custom commands reloaded: ${customCommandsCount}
- Project commands: ${projectCommands}
- User commands: ${userCommands}

Use /help to see updated command list.`
    } catch (error) {
      logError(error)
      debugLogger.warn('REFRESH_COMMANDS_FAILED', {
        error: error instanceof Error ? error.message : String(error),
      })
      return 'Failed to refresh commands. Check debug logs for details.'
    }
  },
  userFacingName() {
    return 'refresh-commands'
  },
} satisfies Command

export default refreshCommands
