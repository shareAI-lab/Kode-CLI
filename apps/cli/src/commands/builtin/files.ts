import type { Command } from '../types'
import { relative } from 'path'

const files = {
  type: 'local',
  name: 'files',
  description: 'List all files currently in context',
  isEnabled: true,
  isHidden: true,
  async call(_args, context) {
    const timestamps = (context as any)?.readFileTimestamps as
      Record<string, number> | undefined

    const paths = Object.keys(timestamps ?? {}).filter(Boolean)
    if (paths.length === 0) return 'No files in context'

    const cwd = process.cwd()
    const lines = paths
      .slice()
      .sort((a, b) => a.localeCompare(b))
      .map(p => {
        try {
          const rel = relative(cwd, p)
          return rel && !rel.startsWith('..') ? rel : p
        } catch {
          return p
        }
      })

    return `Files in context:\n${lines.join('\n')}`
  },
  userFacingName() {
    return 'files'
  },
} satisfies Command

export default files
