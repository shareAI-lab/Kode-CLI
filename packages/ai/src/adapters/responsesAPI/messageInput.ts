import {
  extractTextAndImageUrls,
  getImageUrlFromPart,
  toResponsesImageParts,
} from '../../internal/visionContent'

export function convertMessagesToInput(messages: any[]): any[] {
  // Convert Chat Completions messages to Response API input format
  const inputItems = []

  for (const message of messages) {
    const role = message.role

    if (role === 'tool') {
      // Handle tool call results
      const callId = message.tool_call_id || message.id
      if (typeof callId === 'string' && callId) {
        inputItems.push({
          type: 'function_call_output',
          call_id: callId,
          output: convertToolOutput(message.content),
        })
      }
      continue
    }

    if (role === 'assistant' && Array.isArray(message.tool_calls)) {
      // Handle assistant tool calls
      for (const tc of message.tool_calls) {
        if (typeof tc !== 'object' || tc === null) {
          continue
        }
        const tcType = tc.type || 'function'
        if (tcType !== 'function') {
          continue
        }
        const callId = tc.id || tc.call_id
        const fn = tc.function
        const name = typeof fn === 'object' && fn !== null ? fn.name : null
        const args = typeof fn === 'object' && fn !== null ? fn.arguments : null

        if (
          typeof callId === 'string' &&
          typeof name === 'string' &&
          typeof args === 'string'
        ) {
          inputItems.push({
            type: 'function_call',
            name: name,
            arguments: args,
            call_id: callId,
          })
        }
      }
      continue
    }

    // Handle regular text content
    const content = message.content || ''
    const contentItems = []

    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part !== 'object' || part === null) continue
        const ptype = part.type
        if (ptype === 'text') {
          const text = part.text || part.content || ''
          if (typeof text === 'string' && text) {
            const kind = role === 'assistant' ? 'output_text' : 'input_text'
            contentItems.push({ type: kind, text: text })
          }
        } else if (
          ptype === 'image_url' ||
          ptype === 'image' ||
          ptype === 'input_image'
        ) {
          const imageUrl = getImageUrlFromPart(part)
          if (imageUrl) {
            contentItems.push({ type: 'input_image', image_url: imageUrl })
          }
        }
      }
    } else if (typeof content === 'string' && content) {
      const kind = role === 'assistant' ? 'output_text' : 'input_text'
      contentItems.push({ type: kind, text: content })
    }

    if (contentItems.length) {
      const roleOut = role === 'assistant' ? 'assistant' : 'user'
      inputItems.push({
        type: 'message',
        role: roleOut,
        content: contentItems,
      })
    }
  }

  return inputItems
}

function convertToolOutput(content: unknown): string | any[] {
  const { text, imageUrls } = extractTextAndImageUrls(content)
  if (imageUrls.length === 0) {
    return text
  }

  const output: any[] = []
  if (text) {
    output.push({ type: 'input_text', text })
  }
  output.push(...toResponsesImageParts(imageUrls))
  return output
}

export function buildInstructions(systemPrompt: string[]): string {
  // Join system prompts into instructions
  const systemContent = systemPrompt
    .filter(content => content.trim())
    .join('\n\n')

  return systemContent
}
