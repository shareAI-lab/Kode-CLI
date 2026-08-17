import chalk from 'chalk'

import { isDebugMode } from './mode'
import { terminalLog } from './terminal'

type RoleColor = 'green' | 'blue' | 'yellow' | 'gray'

const ROLE_COLORS: Record<RoleColor, (text: string) => string> = {
  green: chalk.green,
  blue: chalk.blue,
  yellow: chalk.yellow,
  gray: chalk.gray,
}

export function logLLMInteraction(context: {
  systemPrompt: string
  messages: any[]
  response: any
  usage?: {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens?: number
    cacheCreationInputTokens?: number
  }
  timing: { start: number; end: number }
  apiFormat?: 'anthropic' | 'openai'
}) {
  if (!isDebugMode()) return

  const duration = context.timing.end - context.timing.start

  terminalLog('\n' + chalk.blue('🧠 LLM CALL DEBUG'))
  terminalLog(chalk.gray('━'.repeat(60)))

  terminalLog(chalk.yellow('📊 Context Overview:'))
  terminalLog(`   Messages Count: ${context.messages.length}`)
  terminalLog(`   System Prompt Length: ${context.systemPrompt.length} chars`)
  terminalLog(`   Duration: ${duration.toFixed(0)}ms`)

  if (context.usage) {
    const cacheDetails = [
      context.usage.cacheReadInputTokens
        ? `cache read ${context.usage.cacheReadInputTokens}`
        : null,
      context.usage.cacheCreationInputTokens
        ? `cache write ${context.usage.cacheCreationInputTokens}`
        : null,
    ]
      .filter(Boolean)
      .join(', ')
    terminalLog(
      `   Token Usage: ${context.usage.inputTokens} → ${context.usage.outputTokens}${cacheDetails ? ` (${cacheDetails})` : ''}`,
    )
  }

  const apiLabel = context.apiFormat
    ? ` (${context.apiFormat.toUpperCase()})`
    : ''
  terminalLog(chalk.cyan(`\n💬 Real API Messages${apiLabel} (last 10):`))

  const recentMessages = context.messages.slice(-10)
  recentMessages.forEach((msg, index) => {
    const globalIndex = context.messages.length - recentMessages.length + index
    const roleColor: RoleColor =
      msg.role === 'user'
        ? 'green'
        : msg.role === 'assistant'
          ? 'blue'
          : msg.role === 'system'
            ? 'yellow'
            : 'gray'

    let content = ''
    let isReminder = false

    if (typeof msg.content === 'string') {
      if (msg.content.includes('<system-reminder>')) {
        isReminder = true
        const reminderContent = msg.content
          .replace(/<\/?system-reminder>/g, '')
          .trim()
        content = `🔔 ${reminderContent.length > 800 ? reminderContent.substring(0, 800) + '...' : reminderContent}`
      } else {
        const maxLength =
          msg.role === 'user' ? 1000 : msg.role === 'system' ? 1200 : 800
        content =
          msg.content.length > maxLength
            ? msg.content.substring(0, maxLength) + '...'
            : msg.content
      }
    } else if (Array.isArray(msg.content)) {
      const textBlocks = msg.content.filter(
        (block: any) => block.type === 'text',
      )
      const toolBlocks = msg.content.filter(
        (block: any) => block.type === 'tool_use',
      )
      if (textBlocks.length > 0) {
        const text = textBlocks[0].text || ''
        const maxLength = msg.role === 'assistant' ? 1000 : 800
        content =
          text.length > maxLength ? text.substring(0, maxLength) + '...' : text
      }
      if (toolBlocks.length > 0) {
        content += ` [+ ${toolBlocks.length} tool calls]`
      }
      if (textBlocks.length === 0 && toolBlocks.length === 0) {
        content = `[${msg.content.length} blocks: ${msg.content.map((b: any) => b.type || 'unknown').join(', ')}]`
      }
    } else {
      content = '[complex_content]'
    }

    if (isReminder) {
      terminalLog(
        `   [${globalIndex}] ${chalk.magenta('🔔 REMINDER')}: ${chalk.dim(content)}`,
      )
    } else {
      const roleIcon =
        msg.role === 'user'
          ? '👤'
          : msg.role === 'assistant'
            ? '🤖'
            : msg.role === 'system'
              ? '⚙️'
              : '📄'
      const roleLabel = String(msg.role ?? '').toUpperCase()
      terminalLog(
        `   [${globalIndex}] ${ROLE_COLORS[roleColor](roleIcon + ' ' + roleLabel)}: ${content}`,
      )
    }

    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const toolCalls = msg.content.filter(
        (block: any) => block.type === 'tool_use',
      )
      if (toolCalls.length > 0) {
        terminalLog(
          chalk.cyan(
            `       🔧 → Tool calls (${toolCalls.length}): ${toolCalls.map((t: any) => t.name).join(', ')}`,
          ),
        )
        toolCalls.forEach((tool: any, idx: number) => {
          const inputStr = JSON.stringify(tool.input || {})
          const maxLength = 200
          const displayInput =
            inputStr.length > maxLength
              ? inputStr.substring(0, maxLength) + '...'
              : inputStr
          terminalLog(
            chalk.dim(`         [${idx}] ${tool.name}: ${displayInput}`),
          )
        })
      }
    }
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      terminalLog(
        chalk.cyan(
          `       🔧 → Tool calls (${msg.tool_calls.length}): ${msg.tool_calls.map((t: any) => t.function.name).join(', ')}`,
        ),
      )
      msg.tool_calls.forEach((tool: any, idx: number) => {
        const inputStr = tool.function.arguments || '{}'
        const maxLength = 200
        const displayInput =
          inputStr.length > maxLength
            ? inputStr.substring(0, maxLength) + '...'
            : inputStr
        terminalLog(
          chalk.dim(`         [${idx}] ${tool.function.name}: ${displayInput}`),
        )
      })
    }
  })

  terminalLog(chalk.magenta('\n🤖 LLM Response:'))

  let responseContent = ''
  let toolCalls: any[] = []

  if (Array.isArray(context.response.content)) {
    const textBlocks = context.response.content.filter(
      (block: any) => block.type === 'text',
    )
    responseContent = textBlocks.length > 0 ? textBlocks[0].text || '' : ''
    toolCalls = context.response.content.filter(
      (block: any) => block.type === 'tool_use',
    )
  } else if (typeof context.response.content === 'string') {
    responseContent = context.response.content
    toolCalls = context.response.tool_calls || context.response.toolCalls || []
  } else if (context.response.message?.content) {
    if (Array.isArray(context.response.message.content)) {
      const textBlocks = context.response.message.content.filter(
        (block: any) => block.type === 'text',
      )
      responseContent = textBlocks.length > 0 ? textBlocks[0].text || '' : ''
      toolCalls = context.response.message.content.filter(
        (block: any) => block.type === 'tool_use',
      )
    } else if (typeof context.response.message.content === 'string') {
      responseContent = context.response.message.content
    }
  } else {
    responseContent = JSON.stringify(
      context.response.content || context.response || '',
    )
  }

  const maxResponseLength = 1000
  const displayContent =
    responseContent.length > maxResponseLength
      ? responseContent.substring(0, maxResponseLength) + '...'
      : responseContent
  terminalLog(`   Content: ${displayContent}`)

  if (toolCalls.length > 0) {
    const toolNames = toolCalls.map(
      (t: any) => t.name || t.function?.name || 'unknown',
    )
    terminalLog(
      chalk.cyan(
        `   🔧 Tool Calls (${toolCalls.length}): ${toolNames.join(', ')}`,
      ),
    )
    toolCalls.forEach((tool: any, index: number) => {
      const toolName = tool.name || tool.function?.name || 'unknown'
      const toolInput = tool.input || tool.function?.arguments || '{}'
      const inputStr =
        typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput)
      const maxToolInputLength = 300
      const displayInput =
        inputStr.length > maxToolInputLength
          ? inputStr.substring(0, maxToolInputLength) + '...'
          : inputStr
      terminalLog(chalk.dim(`     [${index}] ${toolName}: ${displayInput}`))
    })
  }

  terminalLog(
    `   Stop Reason: ${context.response.stop_reason || context.response.finish_reason || 'unknown'}`,
  )
  terminalLog(chalk.gray('━'.repeat(60)))
}

export function logSystemPromptConstruction(construction: {
  basePrompt: string
  kodeContext?: string
  reminders: string[]
  finalPrompt: string
}) {
  if (!isDebugMode()) return

  terminalLog('\n' + chalk.yellow('📝 SYSTEM PROMPT CONSTRUCTION'))
  terminalLog(`   Base Prompt: ${construction.basePrompt.length} chars`)

  if (construction.kodeContext) {
    terminalLog(`   + Kode Context: ${construction.kodeContext.length} chars`)
  }

  if (construction.reminders.length > 0) {
    terminalLog(
      `   + Dynamic Reminders: ${construction.reminders.length} items`,
    )
    construction.reminders.forEach((reminder, index) => {
      terminalLog(chalk.dim(`     [${index}] ${reminder.substring(0, 80)}...`))
    })
  }

  terminalLog(`   = Final Length: ${construction.finalPrompt.length} chars`)
}

export function logContextCompression(compression: {
  beforeMessages: number
  afterMessages: number
  trigger: string
  preservedFiles: string[]
  compressionRatio: number
}) {
  if (!isDebugMode()) return

  terminalLog('\n' + chalk.red('🗜️  CONTEXT COMPRESSION'))
  terminalLog(`   Trigger: ${compression.trigger}`)
  terminalLog(
    `   Messages: ${compression.beforeMessages} → ${compression.afterMessages}`,
  )
  terminalLog(
    `   Compression Ratio: ${(compression.compressionRatio * 100).toFixed(1)}%`,
  )

  if (compression.preservedFiles.length > 0) {
    terminalLog(`   Preserved Files: ${compression.preservedFiles.join(', ')}`)
  }
}

export function logUserFriendly(type: string, data: any, requestId?: string) {
  if (!isDebugMode()) return

  const timestamp = new Date().toLocaleTimeString()
  let message = ''
  let color = chalk.gray
  let icon = '•'

  switch (type) {
    case 'SESSION_START':
      icon = '🚀'
      color = chalk.green
      message = `Session started with ${data.model || 'default model'}`
      break
    case 'QUERY_START':
      icon = '💭'
      color = chalk.blue
      message = `Processing query: "${data.query?.substring(0, 50)}${data.query?.length > 50 ? '...' : ''}"`
      break
    case 'QUERY_PROGRESS':
      icon = '⏳'
      color = chalk.yellow
      message = `${data.phase} (${data.elapsed}ms)`
      break
    case 'QUERY_COMPLETE':
      icon = '✅'
      color = chalk.green
      message = `Query completed in ${data.duration}ms - Cost: $${data.cost} - ${data.tokens} tokens`
      break
    case 'TOOL_EXECUTION':
      icon = '🔧'
      color = chalk.cyan
      message = `${data.toolName}: ${data.action} ${data.target ? '→ ' + data.target : ''}`
      break
    case 'ERROR_OCCURRED':
      icon = '❌'
      color = chalk.red
      message = `${data.error} ${data.context ? '(' + data.context + ')' : ''}`
      break
    case 'PERFORMANCE_SUMMARY':
      icon = '📊'
      color = chalk.magenta
      message = `Session: ${data.queries} queries, $${data.totalCost}, ${data.avgResponseTime}ms avg`
      break
    default:
      message = JSON.stringify(data)
  }

  const reqId = requestId ? chalk.dim(`[${requestId.slice(0, 8)}]`) : ''
  terminalLog(`${color(`[${timestamp}]`)} ${icon} ${color(message)} ${reqId}`)
}
