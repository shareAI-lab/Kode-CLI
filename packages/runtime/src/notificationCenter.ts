export type InAppNotificationKind = 'info' | 'success' | 'warning' | 'error'

export type InAppNotification = {
  id: string
  createdAt: number
  title?: string
  message: string
  kind?: InAppNotificationKind
  source?: 'desktop' | 'tui' | 'system'
  channel?: string
}

type Listener = () => void

const listeners = new Set<Listener>()
let notifications: InAppNotification[] = []
let seq = 0

const MAX_NOTIFICATIONS = 200

function nextId(): string {
  seq = (seq + 1) % 1_000_000_000
  return `${Date.now()}-${seq}`
}

function emit(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // ignore listener failures
    }
  }
}

export function getNotifications(): InAppNotification[] {
  return notifications
}

export function subscribeNotifications(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function addNotification(
  notif: Omit<InAppNotification, 'id' | 'createdAt'> & {
    id?: string
    createdAt?: number
  },
): InAppNotification {
  const id = notif.id ?? nextId()
  const record: InAppNotification = {
    id,
    createdAt: notif.createdAt ?? Date.now(),
    title: notif.title,
    message: notif.message,
    kind: notif.kind,
    source: notif.source,
    channel: notif.channel,
  }

  const existingIndex = notif.id
    ? notifications.findIndex(item => item.id === notif.id)
    : -1
  notifications =
    existingIndex === -1
      ? [...notifications, record].slice(-MAX_NOTIFICATIONS)
      : [
          ...notifications.slice(0, existingIndex),
          ...notifications.slice(existingIndex + 1),
          record,
        ].slice(-MAX_NOTIFICATIONS)
  emit()
  return record
}

export function removeNotification(id: string): void {
  const next = notifications.filter(n => n.id !== id)
  if (next.length === notifications.length) return
  notifications = next
  emit()
}

export function clearNotifications(): void {
  if (notifications.length === 0) return
  notifications = []
  emit()
}
