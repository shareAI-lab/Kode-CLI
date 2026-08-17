import { last } from 'lodash-es'
import type { Command } from '#cli-commands'
import { getContext } from '@kode/context'
import { getTotalCost } from '#core/cost-tracker'
import type { Message } from '#core/query'
import { query } from '@kode/engine/orchestrator'
import type { CanUseToolFn } from '#core/permissions/canUseTool'
import type { Tool } from '#core/tooling/Tool'
import type { ToolPermissionContext } from '#core/types/toolPermissionContext'
import type { WrappedClient } from '#core/mcp/client'
import { buildSystemPromptForSession } from '@kode/engine'
import { setCwd } from '#core/utils/state'
import { getMessagesPath, overwriteLog } from '#core/utils/log'
import { createUserMessage } from '#core/utils/messages'
import { getMaxThinkingTokens } from '#core/utils/thinking'
import { getCurrentOutputStyleDefinition } from '#cli-services/outputStyles'

type Props = {
  commands: Command[]
  safeMode?: boolean
  hasPermissionsToUseTool: CanUseToolFn
  messageLogName: string
  prompt: string
  cwd: string
  tools: Tool[]
  verbose?: boolean
  disableSlashCommands?: boolean
  systemPromptOverride?: string
  appendSystemPrompt?: string
  maxThinkingTokens?: number
  maxTurns?: number
  maxBudgetUsd?: number
  initialMessages?: Message[]
  persistSession?: boolean
  toolPermissionContext?: ToolPermissionContext
  shouldAvoidPermissionPrompts?: boolean
  model?: string
  mcpClients?: WrappedClient[]
}

type AskDeps = Partial<{
  getContext: (
    ...args: Parameters<typeof getContext>
  ) => ReturnType<typeof getContext>
  getTotalCost: (
    ...args: Parameters<typeof getTotalCost>
  ) => ReturnType<typeof getTotalCost>
  query: (...args: Parameters<typeof query>) => ReturnType<typeof query>
  buildSystemPromptForSession: (
    ...args: Parameters<typeof buildSystemPromptForSession>
  ) => ReturnType<typeof buildSystemPromptForSession>
  setCwd: (...args: Parameters<typeof setCwd>) => ReturnType<typeof setCwd>
  getMessagesPath: (
    ...args: Parameters<typeof getMessagesPath>
  ) => ReturnType<typeof getMessagesPath>
  overwriteLog: (
    ...args: Parameters<typeof overwriteLog>
  ) => ReturnType<typeof overwriteLog>
  createUserMessage: (
    ...args: Parameters<typeof createUserMessage>
  ) => ReturnType<typeof createUserMessage>
  getCurrentOutputStyleDefinition: (
    ...args: Parameters<typeof getCurrentOutputStyleDefinition>
  ) => ReturnType<typeof getCurrentOutputStyleDefinition>
  getMaxThinkingTokens: (
    ...args: Parameters<typeof getMaxThinkingTokens>
  ) => ReturnType<typeof getMaxThinkingTokens>
}>

// Sends a single prompt to the Anthropic Messages API and returns the response.
// Assumes the CLI is being used non-interactively: it will not ask the user
// for permissions or further input.
export async function ask(
  {
    commands,
    safeMode,
    hasPermissionsToUseTool,
    messageLogName,
    prompt,
    cwd,
    tools,
    verbose = false,
    disableSlashCommands,
    systemPromptOverride,
    appendSystemPrompt,
    maxThinkingTokens,
    maxTurns,
    maxBudgetUsd,
    initialMessages,
    persistSession = true,
    toolPermissionContext,
    shouldAvoidPermissionPrompts,
    model,
    mcpClients,
  }: Props,
  deps?: AskDeps,
): Promise<{
  resultText: string
  totalCost: number
  messageHistoryFile: string
}> {
  const setCwdImpl = deps?.setCwd ?? setCwd
  const createUserMessageImpl = deps?.createUserMessage ?? createUserMessage
  const getCurrentOutputStyleDefinitionImpl =
    deps?.getCurrentOutputStyleDefinition ?? getCurrentOutputStyleDefinition
  const getMaxThinkingTokensImpl =
    deps?.getMaxThinkingTokens ?? getMaxThinkingTokens
  const buildSystemPromptForSessionImpl =
    deps?.buildSystemPromptForSession ?? buildSystemPromptForSession
  const getContextImpl = deps?.getContext ?? getContext
  const queryImpl = deps?.query ?? query
  const getMessagesPathImpl = deps?.getMessagesPath ?? getMessagesPath
  const overwriteLogImpl = deps?.overwriteLog ?? overwriteLog
  const getTotalCostImpl = deps?.getTotalCost ?? getTotalCost

  await setCwdImpl(cwd)
  const message = createUserMessageImpl(prompt)
  const messages: Message[] = [...(initialMessages ?? []), message]

  const effectiveMaxThinkingTokens = (() => {
    if (
      typeof maxThinkingTokens === 'number' &&
      Number.isFinite(maxThinkingTokens) &&
      maxThinkingTokens >= 0
    ) {
      return Math.trunc(maxThinkingTokens)
    }
    return undefined
  })()

  const effectiveMaxTurns = (() => {
    if (typeof maxTurns !== 'number' || !Number.isFinite(maxTurns)) {
      return undefined
    }
    if (maxTurns <= 0) return undefined
    return Math.trunc(maxTurns)
  })()

  const outputStyle = getCurrentOutputStyleDefinitionImpl()
  const [systemPrompt, context, computedMaxThinkingTokens] = await Promise.all([
    buildSystemPromptForSessionImpl({
      disableSlashCommands,
      systemPromptOverride,
      appendSystemPrompt,
      outputStyleActive: outputStyle !== null,
      keepCodingInstructions: outputStyle?.keepCodingInstructions,
    }),
    getContextImpl(),
    effectiveMaxThinkingTokens !== undefined
      ? Promise.resolve(effectiveMaxThinkingTokens)
      : getMaxThinkingTokensImpl(messages),
  ])

  for await (const m of queryImpl(
    messages,
    systemPrompt,
    context,
    hasPermissionsToUseTool,
    {
      options: {
        commands,
        tools,
        verbose,
        safeMode: safeMode ?? false,
        maxTurns: effectiveMaxTurns,
        maxBudgetUsd:
          typeof maxBudgetUsd === 'number' ? maxBudgetUsd : undefined,
        forkNumber: 0,
        messageLogName: 'unused',
        maxThinkingTokens: computedMaxThinkingTokens,
        persistSession,
        toolPermissionContext,
        shouldAvoidPermissionPrompts,
        model,
        mcpClients,
      },
      abortController: new AbortController(),
      messageId: undefined,
      readFileTimestamps: {},
      setToolJSX: () => {}, // No-op function for non-interactive use
    },
  )) {
    messages.push(m)
  }

  const result = last(messages)
  if (!result || result.type !== 'assistant') {
    throw new Error('Expected content to be an assistant message')
  }

  // Filter out thinking blocks from content
  const textContent = result.message.content.find(c => c.type === 'text')
  if (!textContent) {
    throw new Error(
      `Expected at least one text content item, but got ${JSON.stringify(
        result.message.content,
        null,
        2,
      )}`,
    )
  }

  // Write a message log that can be viewed with `kode log`
  const messageHistoryFile = getMessagesPathImpl(messageLogName, 0, 0)
  overwriteLogImpl(messageHistoryFile, messages)

  return {
    resultText: textContent.text,
    totalCost: getTotalCostImpl(),
    messageHistoryFile,
  }
}
