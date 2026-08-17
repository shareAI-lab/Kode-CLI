import { addNotification } from '@kode/runtime'

export type McpListKind = 'tools' | 'prompts' | 'resources'

export type McpListChangedEvent = {
  kind: McpListKind
  server: string
}

type Listener = (event: McpListChangedEvent) => void

const versions: Record<McpListKind, number> = {
  tools: 0,
  prompts: 0,
  resources: 0,
}

const listeners = new Set<Listener>()

export function getMcpListChangedVersion(kind: McpListKind): number {
  return versions[kind]
}

export function subscribeMcpListChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function notifyMcpListChanged(event: McpListChangedEvent): void {
  versions[event.kind] += 1

  addNotification({
    id: `mcp:list-changed:${event.server}:${event.kind}`,
    title: 'MCP list changed',
    message: `${event.server}: ${event.kind}`,
    kind: 'info',
    source: 'system',
    channel: 'mcp:list-changed',
  })

  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      // ignore
    }
  }
}

export function __resetMcpListChangedForTests(): void {
  versions.tools = 0
  versions.prompts = 0
  versions.resources = 0
  listeners.clear()
}
