import {
  listSessionMessageTargets,
  peekSessionMessages,
  type SessionMessage,
} from '@kode/protocol/sessionMessaging'
import { addNotification } from '#core/services/notificationCenter'

export const SESSION_MESSAGE_POLL_INTERVAL_MS = 2_000

export function startSessionMessageNotifications(args: {
  cwd: string
  sessionId: string
  pollIntervalMs?: number
  onArrival?: (messages: SessionMessage[]) => void
}): () => void {
  let disposed = false
  let polling = false
  const notified = new Set<string>()

  const poll = async (): Promise<void> => {
    if (disposed || polling) return
    polling = true
    try {
      const pending = await peekSessionMessages({
        cwd: args.cwd,
        sessionId: args.sessionId,
        limit: 256,
      })
      if (disposed) return
      const arrived = pending.filter(
        message => !notified.has(message.messageId),
      )
      if (arrived.length === 0) return

      const labels = new Map(
        listSessionMessageTargets({
          cwd: args.cwd,
          currentSessionId: args.sessionId,
          limit: 200,
        }).map(target => [target.sessionId, target.label]),
      )
      for (const message of arrived) {
        notified.add(message.messageId)
        const preview = message.body.replace(/\s+/g, ' ').trim()
        const sender =
          labels.get(message.senderSessionId) ?? message.senderSessionId
        addNotification({
          id: `session-message-${message.messageId}`,
          title: 'Session message received',
          message: `From ${sender}: ${
            preview.length > 160 ? `${preview.slice(0, 159)}…` : preview
          }`,
          source: 'system',
          kind: 'info',
          channel: 'session-message',
        })
      }
      if (notified.size > 1_024) {
        const retained = new Set(pending.map(message => message.messageId))
        for (const messageId of notified) {
          if (!retained.has(messageId)) notified.delete(messageId)
          if (notified.size <= 512) break
        }
      }
      args.onArrival?.(arrived)
    } catch {
      // Messaging is supplemental local infrastructure. A transient mailbox
      // failure must not disturb the user's active REPL.
    } finally {
      polling = false
    }
  }

  const interval = setInterval(
    () => void poll(),
    Math.max(
      100,
      Math.floor(args.pollIntervalMs ?? SESSION_MESSAGE_POLL_INTERVAL_MS),
    ),
  )
  interval.unref?.()
  void poll()

  return () => {
    disposed = true
    clearInterval(interval)
  }
}
