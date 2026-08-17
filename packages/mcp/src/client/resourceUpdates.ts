import { addNotification } from '@kode/runtime'

export type McpResourceUpdatedEvent = {
  server: string
  uri: string
}

type Listener = (event: McpResourceUpdatedEvent) => void

const listeners = new Set<Listener>()

export function subscribeMcpResourceUpdated(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function notifyMcpResourceUpdated(event: McpResourceUpdatedEvent): void {
  addNotification({
    id: `mcp:resource-updated:${event.server}:${event.uri}`,
    title: 'MCP resource updated',
    message: `${event.server}: ${event.uri}`,
    kind: 'info',
    source: 'system',
    channel: 'mcp:resource-updated',
  })

  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      // Ignore observer failures; MCP notification delivery must not break IO.
    }
  }
}

export function __resetMcpResourceUpdatesForTests(): void {
  listeners.clear()
}
