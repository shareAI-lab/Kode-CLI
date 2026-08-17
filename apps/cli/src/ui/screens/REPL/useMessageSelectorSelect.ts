import type React from 'react'
import { useCallback, useEffect, useRef } from 'react'
import type { Message as MessageType } from '#core/query'
import type { SetForkConvoWithMessagesOnTheNextRender } from '#ui-ink/types/conversationReset'

function getMessageUuid(message: MessageType): string | undefined {
  const record = message as unknown as { uuid?: unknown }
  return typeof record.uuid === 'string' ? record.uuid : undefined
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  const parts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const record = block as Record<string, unknown>
    if (record.type !== 'text') continue
    parts.push(String(record.text ?? ''))
  }

  return parts.join('\n')
}

export function useMessageSelectorSelect(args: {
  messages: MessageType[]
  setIsMessageSelectorVisible: React.Dispatch<React.SetStateAction<boolean>>
  setForkConvoWithMessagesOnTheNextRender: SetForkConvoWithMessagesOnTheNextRender
  setInputValue: React.Dispatch<React.SetStateAction<string>>
  onCancel: () => void
}) {
  const {
    messages,
    onCancel,
    setForkConvoWithMessagesOnTheNextRender,
    setInputValue,
    setIsMessageSelectorVisible,
  } = args
  const mountedRef = useRef(true)
  const pendingForkRef = useRef<ReturnType<typeof setImmediate> | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (pendingForkRef.current) {
        clearImmediate(pendingForkRef.current)
        pendingForkRef.current = null
      }
    }
  }, [])

  return useCallback(
    (message: MessageType) => {
      setIsMessageSelectorVisible(false)

      const selectedUuid = getMessageUuid(message)
      const selectedIndex =
        selectedUuid === undefined
          ? messages.indexOf(message)
          : messages.findIndex(m => getMessageUuid(m) === selectedUuid)
      if (selectedIndex < 0) return

      onCancel()

      if (pendingForkRef.current) {
        clearImmediate(pendingForkRef.current)
      }

      // Use setImmediate to ensure the "Interrupted by user" message renders
      // before we clear and reset the conversation
      pendingForkRef.current = setImmediate(() => {
        pendingForkRef.current = null
        if (!mountedRef.current) return

        const forkMessages = messages
          .slice(0, selectedIndex)
          .filter(m => m.type !== 'progress')

        // Use clearViewport option - the fork effect will clear terminal and
        // atomically update forkNumber + messages in a single batched update.
        // This prevents intermediate renders that cause content duplication.
        setForkConvoWithMessagesOnTheNextRender(forkMessages, {
          clearViewport: true,
        })

        // Set input value to selected message content if it's a user message
        if (message.type === 'user') {
          setInputValue(extractMessageText(message.message.content))
        }
      })
    },
    [
      messages,
      onCancel,
      setForkConvoWithMessagesOnTheNextRender,
      setInputValue,
      setIsMessageSelectorVisible,
    ],
  )
}
