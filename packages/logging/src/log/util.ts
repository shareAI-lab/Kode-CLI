import type { LogOption } from '@kode/types/logs'

export function sortLogs(logs: LogOption[]): LogOption[] {
  return logs.sort((a, b) => {
    // Sort by modified date (newest first)
    const modifiedDiff = b.modified.getTime() - a.modified.getTime()
    if (modifiedDiff !== 0) {
      return modifiedDiff
    }

    // If modified dates are equal, sort by created date
    const createdDiff = b.created.getTime() - a.created.getTime()
    if (createdDiff !== 0) {
      return createdDiff
    }

    // If both dates are equal, sort by fork number
    return (b.forkNumber ?? 0) - (a.forkNumber ?? 0)
  })
}

export function formatDate(date: Date): string {
  const now = new Date()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)

  const isToday = date.toDateString() === now.toDateString()
  const isYesterday = date.toDateString() === yesterday.toDateString()

  const timeStr = date
    .toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
    .toLowerCase()

  if (isToday) {
    return `Today at ${timeStr}`
  } else if (isYesterday) {
    return `Yesterday at ${timeStr}`
  } else {
    return (
      date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      }) + ` at ${timeStr}`
    )
  }
}

export function parseISOString(s: string): Date {
  const b = s.split(/\D+/)
  return new Date(
    Date.UTC(
      parseInt(b[0]!, 10),
      parseInt(b[1]!, 10) - 1,
      parseInt(b[2]!, 10),
      parseInt(b[3]!, 10),
      parseInt(b[4]!, 10),
      parseInt(b[5]!, 10),
      parseInt(b[6]!, 10),
    ),
  )
}
