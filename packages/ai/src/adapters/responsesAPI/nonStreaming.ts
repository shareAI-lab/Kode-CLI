import type { UnifiedResponse } from '../../internal/modelCapabilityTypes'

function parseToolCalls(response: any): any[] {
  // Tool call parsing (Responses API)
  if (!response.output || !Array.isArray(response.output)) {
    return []
  }

  const toolCalls = []

  for (const item of response.output) {
    if (item.type === 'function_call') {
      // Parse tool call with better structure
      const callId = item.call_id || item.id
      const name = item.name || ''
      const args = item.arguments || '{}'

      // Validate required fields
      if (
        typeof callId === 'string' &&
        typeof name === 'string' &&
        typeof args === 'string'
      ) {
        toolCalls.push({
          id: callId,
          type: 'function',
          function: {
            name: name,
            arguments: args,
          },
        })
      }
    } else if (item.type === 'tool_call') {
      // Handle alternative tool_call type
      const callId =
        item.id || `tool_${Math.random().toString(36).substring(2, 15)}`
      toolCalls.push({
        id: callId,
        type: 'tool_call',
        name: item.name,
        arguments: item.arguments,
      })
    }
  }

  return toolCalls
}

function getOutputText(content: any): string {
  if (typeof content === 'string') return content
  if (!content || typeof content !== 'object') return ''

  if (
    content.type === 'text' ||
    content.type === 'output_text' ||
    content.type === 'input_text'
  ) {
    return typeof content.text === 'string' ? content.text : ''
  }

  if (content.type === 'refusal') {
    if (typeof content.refusal === 'string') return content.refusal
    return typeof content.text === 'string' ? content.text : ''
  }

  return ''
}

function getMessageText(item: any): string {
  if (!item || typeof item !== 'object') return ''
  if (Array.isArray(item.content)) {
    return item.content.map(getOutputText).filter(Boolean).join('\n')
  }
  return getOutputText(item.content)
}

export function parseNonStreamingResponse(response: any): UnifiedResponse {
  // Process basic text output
  let content = response.output_text || ''

  // Extract reasoning content from structured output
  let reasoningContent = ''
  if (response.output && Array.isArray(response.output)) {
    const messageItems = response.output.filter(
      (item: any) => item.type === 'message',
    )
    if (messageItems.length > 0) {
      content = messageItems.map(getMessageText).filter(Boolean).join('\n\n')
    }

    // Extract reasoning content
    const reasoningItems = response.output.filter(
      (item: any) => item.type === 'reasoning',
    )
    if (reasoningItems.length > 0) {
      reasoningContent = reasoningItems
        .map((item: any) => item.content || '')
        .filter(Boolean)
        .join('\n\n')
    }
  }

  // Apply reasoning formatting
  if (reasoningContent) {
    const thinkBlock = `\n\n${reasoningContent}\n\n`
    content = thinkBlock + content
  }

  // Parse tool calls
  const toolCalls = parseToolCalls(response)

  // Build unified response
  // Convert content to array format for Anthropic compatibility
  const contentArray = content
    ? [{ type: 'text', text: content, citations: [] }]
    : [{ type: 'text', text: '', citations: [] }]

  const promptTokens = response.usage?.input_tokens || 0
  const completionTokens = response.usage?.output_tokens || 0
  const totalTokens =
    response.usage?.total_tokens ?? promptTokens + completionTokens

  return {
    id: response.id || `resp_${Date.now()}`,
    content: contentArray, // Return as array (Anthropic format)
    toolCalls,
    usage: {
      promptTokens,
      completionTokens,
      reasoningTokens: response.usage?.output_tokens_details?.reasoning_tokens,
    },
    responseId: response.id, // Save for state management
  }
}
