import chalk from 'chalk'

function asMessageRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  return value as Record<string, unknown>
}

export function formatMessages(messages: unknown): string {
  if (Array.isArray(messages)) {
    const recentMessages = messages.slice(-5)
    return recentMessages
      .map((msg, index) => {
        const record = asMessageRecord(msg)
        const roleRaw = record?.role
        const role = typeof roleRaw === 'string' ? roleRaw : 'unknown'
        const contentRaw = record?.content

        let content = ''
        if (typeof contentRaw === 'string') {
          content =
            contentRaw.length > 300
              ? contentRaw.substring(0, 300) + '...'
              : contentRaw
        } else if (typeof contentRaw === 'object') {
          content = '[complex_content]'
        } else {
          content = String(contentRaw ?? '')
        }

        const totalIndex = messages.length - recentMessages.length + index
        return `[${totalIndex}] ${chalk.dim(role)}: ${content}`
      })
      .join('\n    ')
  }

  if (typeof messages === 'string') {
    try {
      const parsed = JSON.parse(messages) as unknown
      if (Array.isArray(parsed)) {
        return formatMessages(parsed)
      }
    } catch {
      // ignore
    }
  }

  if (typeof messages === 'string' && messages.length > 200) {
    return messages.substring(0, 200) + '...'
  }

  return typeof messages === 'string' ? messages : JSON.stringify(messages)
}

export function formatDataForTerminal(data: unknown): string {
  if (typeof data === 'object' && data !== null) {
    const record = data as Record<string, unknown>
    if ('messages' in record) {
      const formattedMessages = formatMessages(record.messages)
      return JSON.stringify(
        {
          ...record,
          messages: `\n    ${formattedMessages}`,
        },
        null,
        2,
      )
    }
    return JSON.stringify(data, null, 2)
  }

  return typeof data === 'string' ? data : JSON.stringify(data)
}
