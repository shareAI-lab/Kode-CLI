import type { Command } from '../types'
import { loadCustomCommands } from '#cli-services/customCommands'

function isSkill(cmd: Command): boolean {
  return (cmd as unknown as Record<string, unknown>).isSkill === true
}

function getCommandScope(cmd: Command): 'project' | 'user' | null {
  const scope = (cmd as unknown as Record<string, unknown>).scope
  if (scope === 'project' || scope === 'user') return scope
  return null
}

function getCommandFilePath(cmd: Command): string | null {
  const filePath = (cmd as unknown as Record<string, unknown>).filePath
  return typeof filePath === 'string' && filePath.trim() ? filePath : null
}

const skills = {
  type: 'local',
  name: 'skills',
  description: 'List available skills',
  isEnabled: true,
  isHidden: true,
  async call() {
    const commands = await loadCustomCommands()
    const skillCommands = commands.filter(isSkill)

    if (skillCommands.length === 0) {
      return 'No skills found.'
    }

    const lines = skillCommands.map(cmd => {
      const scope = getCommandScope(cmd)
      const filePath = getCommandFilePath(cmd)
      const scopeLabel = scope ? ` (${scope})` : ''
      const pathLabel = filePath ? ` — ${filePath}` : ''
      return `- ${cmd.userFacingName()}${scopeLabel}: ${cmd.description}${pathLabel}`
    })

    return `Available skills (${skillCommands.length}):\n${lines.join('\n')}`
  },
  userFacingName() {
    return 'skills'
  },
} satisfies Command

export default skills
