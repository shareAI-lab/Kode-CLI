import type { ToolUseContext } from '@kode/tool-interface/Tool'
import type { ToolPermissionContext } from '@kode/tool-interface/permissions'
import { getCwd } from '#runtime/cwd'
import { PRODUCT_NAME } from '#config/constants'
import type {
  BashPermissionDecision,
  BashPermissionResult,
  DecisionReason,
} from './types'
import {
  isUnsafeCompoundCommand,
  normalizeBashLineContinuations,
  splitBashCommandIntoSubcommands,
} from './shellTokens'
import { validateBashCommandPaths } from './paths'
import { checkSedCommandSafety } from './sed'
import {
  buildBashRuleSuggestionExact,
  checkExactBashRules,
  checkPrefixBashRules,
  checkPromptBashRules,
  modeSpecificBashDecision,
} from './rules'
import { xi } from './xi'
import { checkBashCommandSyntax } from './validators'
import { LEGACY_ENV } from '#config/compat/legacyEnv'

function formatDecisionReason(
  reason: DecisionReason | undefined,
): string | undefined {
  if (!reason) return undefined
  if (reason.type === 'rule') return reason.rule
  if (reason.type === 'other') return reason.reason

  // Compound command: show the first non-allowing subcommand reason (best-effort).
  for (const [subcommand, decision] of reason.reasons) {
    if (decision.behavior === 'allow') continue
    const inner = formatDecisionReason(decision.decisionReason)
    return inner ? `${subcommand}: ${inner}` : subcommand
  }
  return 'Compound command requires approval'
}

function parseBoolLikeEnv(value: string | undefined): boolean {
  if (!value) return false
  const v = value.trim().toLowerCase()
  return ['1', 'true', 'yes', 'y', 'on', 'enable', 'enabled'].includes(v)
}

function h02(args: {
  command: string
  description?: string
  cwd: string
  toolPermissionContext: ToolPermissionContext
  hasCdInCompound: boolean
}): BashPermissionDecision {
  const trimmed = args.command.trim()
  const prompt =
    typeof args.description === 'string' ? args.description.trim() : ''
  const promptMatches = prompt
    ? checkPromptBashRules(prompt, args.toolPermissionContext)
    : {}

  if (promptMatches.deny) {
    return {
      behavior: 'deny',
      message: `Permission to use Bash with command ${trimmed} has been denied.`,
      decisionReason: { type: 'rule', rule: promptMatches.deny },
    }
  }

  const exact = checkExactBashRules(trimmed, args.toolPermissionContext)
  if (exact.behavior === 'deny' || exact.behavior === 'ask') return exact

  const prefixMatches = checkPrefixBashRules(
    trimmed,
    args.toolPermissionContext,
  )
  if (prefixMatches.deny) {
    return {
      behavior: 'deny',
      message: `Permission to use Bash with command ${trimmed} has been denied.`,
      decisionReason: { type: 'rule', rule: prefixMatches.deny },
    }
  }

  if (promptMatches.ask) {
    return {
      behavior: 'ask',
      message: `${PRODUCT_NAME} requested permissions to use Bash, but you haven't granted it yet.`,
      decisionReason: { type: 'rule', rule: promptMatches.ask },
    }
  }
  if (prefixMatches.ask) {
    return {
      behavior: 'ask',
      message: `${PRODUCT_NAME} requested permissions to use Bash, but you haven't granted it yet.`,
      decisionReason: { type: 'rule', rule: prefixMatches.ask },
    }
  }

  const pathDecision = validateBashCommandPaths({
    command: trimmed,
    cwd: args.cwd,
    toolPermissionContext: args.toolPermissionContext,
    hasCdInCompound: args.hasCdInCompound,
  })
  if (pathDecision.behavior !== 'passthrough') return pathDecision

  if (promptMatches.allow) {
    return {
      behavior: 'allow',
      updatedInput: { command: trimmed },
      decisionReason: { type: 'rule', rule: promptMatches.allow },
    }
  }
  if (exact.behavior === 'allow') return exact

  if (prefixMatches.allow) {
    return {
      behavior: 'allow',
      updatedInput: { command: trimmed },
      decisionReason: { type: 'rule', rule: prefixMatches.allow },
    }
  }

  const sedDecision = checkSedCommandSafety({
    command: trimmed,
    toolPermissionContext: args.toolPermissionContext,
  })
  if (sedDecision.behavior !== 'passthrough') return sedDecision

  const modeDecision = modeSpecificBashDecision(
    trimmed,
    args.toolPermissionContext,
  )
  if (modeDecision.behavior !== 'passthrough') return modeDecision

  if (
    !parseBoolLikeEnv(
      process.env.KODE_DISABLE_COMMAND_INJECTION_CHECK ??
        process.env[LEGACY_ENV.codeDisableCommandInjectionCheck],
    )
  ) {
    const security = xi(trimmed)
    if (security.behavior !== 'passthrough') {
      const reason: DecisionReason = {
        type: 'other',
        reason:
          security.message ||
          'This command contains patterns that could pose security risks and requires approval',
      }
      return {
        behavior: 'ask',
        message:
          security.message ||
          `${PRODUCT_NAME} requested permissions to use Bash, but you haven't granted it yet.`,
        decisionReason: reason,
        suggestions: [],
      }
    }
  }

  return {
    behavior: 'passthrough',
    message: `${PRODUCT_NAME} requested permissions to use Bash, but you haven't granted it yet.`,
    decisionReason: { type: 'other', reason: 'This command requires approval' },
    suggestions: buildBashRuleSuggestionExact(trimmed),
  }
}

export async function checkBashPermissions(args: {
  command: string
  description?: string
  toolPermissionContext: ToolPermissionContext
  toolUseContext: ToolUseContext
  getCwdForPaths?: () => string
}): Promise<BashPermissionResult> {
  const cwd = (args.getCwdForPaths ?? getCwd)()
  const trimmed = normalizeBashLineContinuations(args.command).trim()

  const syntax = checkBashCommandSyntax(trimmed)
  if (syntax.behavior !== 'passthrough') {
    return {
      result: false,
      message:
        'message' in syntax
          ? syntax.message
          : `${PRODUCT_NAME} requested permissions to use Bash, but you haven't granted it yet.`,
      decisionReason:
        'message' in syntax && typeof syntax.message === 'string'
          ? syntax.message
          : 'Invalid Bash syntax requires approval',
      requiresExplicitApproval: true,
    }
  }

  if (
    !parseBoolLikeEnv(
      process.env.KODE_DISABLE_COMMAND_INJECTION_CHECK ??
        process.env[LEGACY_ENV.codeDisableCommandInjectionCheck],
    ) &&
    isUnsafeCompoundCommand(trimmed)
  ) {
    const security = xi(trimmed)
    return {
      result: false,
      message:
        security.behavior === 'ask' && security.message
          ? security.message
          : `${PRODUCT_NAME} requested permissions to use Bash, but you haven't granted it yet.`,
      decisionReason:
        security.behavior === 'ask' && security.message
          ? security.message
          : 'Unsafe compound command requires approval',
      requiresExplicitApproval: true,
    }
  }

  const subcommands = splitBashCommandIntoSubcommands(trimmed).filter(
    cmd => cmd !== `cd ${cwd}`,
  )
  const isCompound = subcommands.length > 1
  const promptForSingleCommand = !isCompound ? args.description : undefined

  // IMPORTANT (security + parity):
  // Avoid allowing/denying a compound command list via a single wildcard rule
  // that matches the full command string. Compound commands are evaluated
  // per-subcommand; the full-command match is only considered for single
  // commands.
  const fullExact = !isCompound
    ? checkExactBashRules(trimmed, args.toolPermissionContext)
    : null

  if (fullExact?.behavior === 'deny') {
    return {
      result: false,
      message: fullExact.message,
      shouldPromptUser: false,
      decisionReason: formatDecisionReason(fullExact.decisionReason),
      blockedPath: fullExact.blockedPath,
    }
  }

  const cdCommands = subcommands.filter(cmd => cmd.trim().startsWith('cd '))
  if (cdCommands.length > 1) {
    return {
      result: false,
      message: `${PRODUCT_NAME} requested permissions to use Bash, but you haven't granted it yet.`,
    }
  }
  const hasCdInCompound = cdCommands.length > 0

  const subResults = new Map<string, BashPermissionDecision>()
  for (const sub of subcommands) {
    const decision = h02({
      command: sub,
      description: promptForSingleCommand,
      cwd,
      toolPermissionContext: args.toolPermissionContext,
      hasCdInCompound,
    })
    subResults.set(sub, decision)
  }

  for (const decision of subResults.values()) {
    if (decision.behavior === 'deny') {
      return {
        result: false,
        message: decision.message,
        shouldPromptUser: false,
        decisionReason: formatDecisionReason(decision.decisionReason),
        blockedPath: decision.blockedPath,
      }
    }
  }

  const fullPathDecision = validateBashCommandPaths({
    command: trimmed,
    cwd,
    toolPermissionContext: args.toolPermissionContext,
    hasCdInCompound,
  })
  if (fullPathDecision.behavior === 'deny') {
    return {
      result: false,
      message: fullPathDecision.message,
      shouldPromptUser: false,
      decisionReason: formatDecisionReason(fullPathDecision.decisionReason),
      blockedPath: fullPathDecision.blockedPath,
    }
  }
  if (fullPathDecision.behavior === 'ask') {
    return {
      result: false,
      message: fullPathDecision.message,
      suggestions: fullPathDecision.suggestions,
      decisionReason: formatDecisionReason(fullPathDecision.decisionReason),
      blockedPath: fullPathDecision.blockedPath,
      requiresExplicitApproval: true,
    }
  }

  for (const decision of subResults.values()) {
    if (decision.behavior === 'ask') {
      return {
        result: false,
        message: decision.message,
        suggestions: decision.suggestions,
        decisionReason: formatDecisionReason(decision.decisionReason),
        blockedPath: decision.blockedPath,
        requiresExplicitApproval: true,
      }
    }
  }

  if (!isCompound && fullExact?.behavior === 'allow') return { result: true }

  if (Array.from(subResults.values()).every(d => d.behavior === 'allow')) {
    return { result: true }
  }

  return {
    result: false,
    message: `${PRODUCT_NAME} requested permissions to use Bash, but you haven't granted it yet.`,
    suggestions: buildBashRuleSuggestionExact(trimmed),
    decisionReason: 'No allow rule matched',
  }
}

export function checkBashPermissionsAutoAllowedBySandbox(args: {
  command: string
  toolPermissionContext: ToolPermissionContext
}): BashPermissionResult {
  const cwd = getCwd()
  const trimmed = normalizeBashLineContinuations(args.command).trim()

  let subcommands: string[]
  try {
    subcommands = splitBashCommandIntoSubcommands(trimmed).filter(
      cmd => cmd !== `cd ${cwd}`,
    )
  } catch {
    return {
      result: false,
      message: `${PRODUCT_NAME} requested permissions to use Bash, but you haven't granted it yet.`,
      decisionReason: 'Unable to parse Bash command for sandbox auto-allow',
    }
  }

  for (const subcommand of subcommands) {
    const prefixMatches = checkPrefixBashRules(
      subcommand,
      args.toolPermissionContext,
    )

    if (prefixMatches.deny) {
      return {
        result: false,
        message: `Permission to use Bash with command ${subcommand.trim()} has been denied.`,
        shouldPromptUser: false,
        decisionReason: prefixMatches.deny,
      }
    }
    if (prefixMatches.ask) {
      return {
        result: false,
        message: `${PRODUCT_NAME} requested permissions to use Bash, but you haven't granted it yet.`,
        decisionReason: prefixMatches.ask,
        requiresExplicitApproval: true,
      }
    }
  }

  return { result: true }
}
