import { addToHistory } from '#core/history'
import { hasPermissionsToUseTool } from '#core/permissions'
import { dateToFilename } from '#core/utils/log'

import type { Command } from '#cli-commands'
import type { WrappedClient } from '#core/mcp/client'
import type { Message } from '#core/query'
import type { Tool } from '#core/tooling/Tool'
import type { ask as askImpl } from '#cli-utils/ask'

import { finishHeadlessRun, startHeadlessRun } from './headlessRunTelemetry'

export type RunPrintModeArgs = {
  prompt: string | undefined
  stdinContent: string
  inputPrompt: string

  cwd: string
  safe?: boolean
  verbose?: boolean

  outputFormat?: string
  inputFormat?: string
  jsonSchema?: string
  permissionPromptTool?: string | null
  maxThinkingTokens?: number
  maxTurns?: number
  maxBudgetUsd?: number
  includePartialMessages?: boolean
  replayUserMessages?: boolean

  cliTools?: unknown
  tools: Tool[]
  commands: Command[]
  ask: typeof askImpl

  initialMessages?: Message[]
  sessionPersistence?: boolean

  systemPromptOverride?: string
  appendSystemPrompt?: string
  disableSlashCommands?: boolean

  allowedTools?: unknown
  disallowedTools?: unknown
  addDir?: unknown
  permissionMode?: string
  dangerouslySkipPermissions?: boolean
  allowDangerouslySkipPermissions?: boolean

  model?: string
  mcpClients: WrappedClient[]
}

export async function runPrintMode({
  prompt,
  stdinContent,
  inputPrompt,
  cwd,
  safe,
  verbose,
  outputFormat,
  inputFormat,
  jsonSchema,
  permissionPromptTool,
  maxThinkingTokens,
  maxTurns,
  maxBudgetUsd,
  includePartialMessages,
  replayUserMessages,
  cliTools,
  tools,
  commands,
  ask,
  initialMessages,
  sessionPersistence,
  systemPromptOverride,
  appendSystemPrompt,
  disableSlashCommands,
  allowedTools,
  disallowedTools,
  addDir,
  permissionMode,
  dangerouslySkipPermissions,
  allowDangerouslySkipPermissions,
  model,
  mcpClients,
}: RunPrintModeArgs): Promise<void> {
  const normalizedOutputFormat = String(outputFormat || 'text')
    .toLowerCase()
    .trim()
  const normalizedInputFormat = String(inputFormat || 'text')
    .toLowerCase()
    .trim()

  if (!['text', 'stream-json'].includes(normalizedInputFormat)) {
    console.error(
      `Error: Invalid --input-format "${inputFormat}". Expected one of: text, stream-json`,
    )
    process.exit(1)
  }

  if (!['text', 'json', 'stream-json'].includes(normalizedOutputFormat)) {
    console.error(
      `Error: Invalid --output-format "${outputFormat}". Expected one of: text, json, stream-json`,
    )
    process.exit(1)
  }

  if (normalizedOutputFormat === 'stream-json' && !verbose) {
    console.error(
      'Error: When using --print/--headless, --output-format=stream-json requires --verbose',
    )
    process.exit(1)
  }

  const normalizedPermissionPromptTool = permissionPromptTool
    ? String(permissionPromptTool).trim()
    : null

  if (includePartialMessages && normalizedOutputFormat !== 'stream-json') {
    console.error(
      'Error: --include-partial-messages requires --print/--headless and --output-format=stream-json.',
    )
    process.exit(1)
  }

  if (normalizedPermissionPromptTool) {
    if (normalizedPermissionPromptTool !== 'stdio') {
      console.error(
        `Error: Unsupported --permission-prompt-tool "${normalizedPermissionPromptTool}". Only "stdio" is supported in Kode right now.`,
      )
      process.exit(1)
    }
    if (normalizedInputFormat !== 'stream-json') {
      console.error(
        'Error: --permission-prompt-tool=stdio requires --input-format=stream-json',
      )
      process.exit(1)
    }
    if (normalizedOutputFormat !== 'stream-json') {
      console.error(
        'Error: --permission-prompt-tool=stdio requires --output-format=stream-json',
      )
      process.exit(1)
    }
  }

  if (
    normalizedInputFormat === 'stream-json' &&
    normalizedOutputFormat !== 'stream-json'
  ) {
    console.error(
      'Error: --input-format=stream-json requires output-format=stream-json.',
    )
    process.exit(1)
  }

  if (replayUserMessages) {
    if (
      normalizedInputFormat !== 'stream-json' ||
      normalizedOutputFormat !== 'stream-json'
    ) {
      console.error(
        'Error: --replay-user-messages requires both --input-format=stream-json and --output-format=stream-json.',
      )
      process.exit(1)
    }
  }

  if (normalizedInputFormat === 'stream-json') {
    if (prompt) {
      console.error(
        'Error: --input-format=stream-json cannot be used with a prompt argument',
      )
      process.exit(1)
    }
    if (stdinContent) {
      console.error(
        'Error: --input-format=stream-json cannot be used with stdin prompt text',
      )
      process.exit(1)
    }
  } else {
    if (!inputPrompt) {
      console.error(
        'Error: Input must be provided either through stdin or as a prompt argument when using --print or --headless',
      )
      process.exit(1)
    }
  }

  const toolsForPrint = (() => {
    if (!cliTools) return tools
    const raw = Array.isArray(cliTools) ? cliTools : [cliTools]
    const flattened = raw
      .flatMap(v => String(v ?? '').split(','))
      .map(v => v.trim())
    if (flattened.length === 0) return tools

    if (flattened.length === 1 && flattened[0] === '') return []
    if (flattened.length === 1 && flattened[0] === 'default') return tools

    const wanted = new Set(flattened.filter(v => v && v !== 'default'))
    const unknown = [...wanted].filter(
      name => !tools.some(t => t.name === name),
    )
    if (unknown.length > 0) {
      console.error(`Error: Unknown tool(s) in --tools: ${unknown.join(', ')}`)
      process.exit(1)
    }

    return tools.filter(t => wanted.has(t.name))
  })()

  if (normalizedOutputFormat === 'text') {
    addToHistory(inputPrompt)
    const headlessRun = startHeadlessRun({
      cwd,
      inputFormat: normalizedInputFormat,
      outputFormat: normalizedOutputFormat,
      promptChars: inputPrompt.length,
      toolCount: toolsForPrint.length,
      model,
      maxTurns,
      maxBudgetUsd,
    })
    try {
      const { resultText: response, totalCost } = await ask({
        commands,
        hasPermissionsToUseTool,
        messageLogName: dateToFilename(new Date()),
        prompt: inputPrompt,
        cwd,
        tools: toolsForPrint,
        safeMode: safe,
        disableSlashCommands,
        systemPromptOverride,
        appendSystemPrompt,
        maxThinkingTokens,
        maxTurns,
        maxBudgetUsd,
        initialMessages,
        persistSession: sessionPersistence !== false,
      })

      const budgetExceeded =
        typeof maxBudgetUsd === 'number' &&
        Number.isFinite(maxBudgetUsd) &&
        maxBudgetUsd > 0 &&
        totalCost >= maxBudgetUsd

      if (budgetExceeded) {
        finishHeadlessRun(headlessRun, {
          resultSubtype: 'error_max_budget_usd',
          totalCostUsd: totalCost,
        })
        process.stdout.write(`Error: Exceeded USD budget (${maxBudgetUsd})\n`)
        process.exit(0)
      }

      finishHeadlessRun(headlessRun, {
        totalCostUsd: totalCost,
      })
      process.stdout.write(`${response}\n`)
      process.exit(0)
    } catch (error) {
      const { MaxBudgetUsdExceededError } =
        await import('#core/errors/maxBudgetUsd')
      const { MaxTurnsExceededError } = await import('#core/errors/maxTurns')
      if (error instanceof MaxBudgetUsdExceededError) {
        const budget = maxBudgetUsd ?? error.maxBudgetUsd
        finishHeadlessRun(headlessRun, {
          resultSubtype: 'error_max_budget_usd',
          error,
        })
        process.stdout.write(`Error: Exceeded USD budget (${budget})\n`)
        process.exit(0)
      }
      if (error instanceof MaxTurnsExceededError) {
        finishHeadlessRun(headlessRun, {
          resultSubtype: 'error_max_turns',
          error,
          numTurns: error.turnCount,
        })
        process.stdout.write(
          `Error: Reached max turns limit (${error.maxTurns})\n`,
        )
        process.exit(0)
      }

      finishHeadlessRun(headlessRun, {
        isError: true,
        resultSubtype: 'error_during_execution',
        error,
      })
      process.stdout.write('Execution error\n')
      process.exit(1)
    }
  }

  if (
    normalizedOutputFormat !== 'json' &&
    normalizedOutputFormat !== 'stream-json'
  ) {
    console.error(
      `Error: Invalid --output-format "${outputFormat}". Expected one of: json, stream-json`,
    )
    process.exit(1)
  }

  if (
    normalizedInputFormat !== 'text' &&
    normalizedInputFormat !== 'stream-json'
  ) {
    console.error(
      `Error: Invalid --input-format "${inputFormat}". Expected one of: text, stream-json`,
    )
    process.exit(1)
  }

  const { runNonTextPrintMode } = await import('./runNonTextPrintMode')
  await runNonTextPrintMode({
    inputPrompt,
    cwd,
    safe,
    verbose,
    normalizedOutputFormat,
    normalizedInputFormat,
    normalizedPermissionPromptTool,
    replayUserMessages,
    toolsForPrint,
    commands,
    initialMessages,
    sessionPersistence,
    systemPromptOverride,
    appendSystemPrompt,
    disableSlashCommands,
    maxThinkingTokens,
    maxTurns,
    maxBudgetUsd,
    includePartialMessages,
    allowedTools,
    disallowedTools,
    addDir,
    permissionMode,
    dangerouslySkipPermissions,
    allowDangerouslySkipPermissions,
    jsonSchema,
    model,
    mcpClients,
  })
}
