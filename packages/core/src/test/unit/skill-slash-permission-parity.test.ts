import { beforeEach, describe, expect, test } from 'bun:test'
import { homedir } from 'os'
import { join } from 'path'
import { hasPermissionsToUseTool } from '#core/permissions'
import { FileEditTool } from '#tools/tools/filesystem/FileEditTool/FileEditTool'
import { FileReadTool } from '#tools/tools/filesystem/FileReadTool/FileReadTool'
import { FileWriteTool } from '#tools/tools/filesystem/FileWriteTool/FileWriteTool'
import { SlashCommandTool } from '#tools/tools/interaction/SlashCommandTool/SlashCommandTool'
import { SkillTool } from '#tools/tools/interaction/SkillTool/SkillTool'
import {
  getCurrentProjectConfig,
  saveCurrentProjectConfig,
} from '#core/utils/config'
import type { ToolUseContext } from '#core/tooling/Tool'
import { createAssistantMessage } from '#core/utils/messages'

function makeContext(overrides?: Partial<ToolUseContext>): ToolUseContext {
  const base: ToolUseContext = {
    abortController: new AbortController(),
    messageId: 'test',
    options: {
      commands: [],
      tools: [],
      verbose: false,
      safeMode: false,
      permissionMode: 'acceptEdits',
      forkNumber: 0,
      messageLogName: 'test',
      maxThinkingTokens: 0,
      model: 'main',
    },
    readFileTimestamps: {},
  }
  return {
    ...base,
    ...overrides,
    options: {
      ...base.options,
      ...(overrides?.options ?? {}),
    },
  }
}

beforeEach(() => {
  const cfg = getCurrentProjectConfig()
  saveCurrentProjectConfig({
    ...cfg,
    allowedTools: [],
    deniedTools: [],
    askedTools: [],
  })
})

describe('Skill/SlashCommand parity: contextModifier effects', () => {
  test('SkillTool maps haiku/sonnet/opus to model pointers and sets maxThinkingTokens', async () => {
    const cmd = {
      type: 'prompt',
      name: 'pdf',
      disableModelInvocation: false,
      allowedTools: ['Read(~/**)'],
      model: 'haiku',
      maxThinkingTokens: 123,
      userFacingName() {
        return 'pdf'
      },
      async getPromptForCommand() {
        return [{ role: 'user', content: 'do something' }]
      },
    }

    const ctx = makeContext({ options: { commands: [cmd] } })
    const gen = SkillTool.call({ skill: 'pdf' }, ctx)
    const first = await gen.next()
    if (
      first.done ||
      !first.value ||
      first.value.type !== 'result' ||
      !first.value.contextModifier
    ) {
      throw new Error(
        'Expected SkillTool to yield a result with contextModifier',
      )
    }
    const nextCtx = first.value.contextModifier.modifyContext(ctx)
    expect(nextCtx.options!.model).toBe('quick')
    expect(nextCtx.options!.maxThinkingTokens).toBe(123)
    expect(nextCtx.options!.commandAllowedTools).toContain('Read(~/**)')
  })

  test('SlashCommandTool sets model/maxThinkingTokens and accumulates allowed tools', async () => {
    const cmd = {
      type: 'prompt',
      name: 'review-pr',
      disableModelInvocation: false,
      allowedTools: ['Edit(~/.kode/settings.json)'],
      model: 'sonnet',
      maxThinkingTokens: 456,
      userFacingName() {
        return 'review-pr'
      },
      async getPromptForCommand() {
        return [{ role: 'user', content: 'expand' }]
      },
    }

    const ctx = makeContext({ options: { commands: [cmd] } })
    const gen = SlashCommandTool.call({ command: '/review-pr 123' }, ctx)
    const first = await gen.next()
    if (
      first.done ||
      !first.value ||
      first.value.type !== 'result' ||
      !first.value.contextModifier
    ) {
      throw new Error(
        'Expected SlashCommandTool to yield a result with contextModifier',
      )
    }
    const nextCtx = first.value.contextModifier.modifyContext(ctx)
    expect(nextCtx.options!.model).toBe('task')
    expect(nextCtx.options!.maxThinkingTokens).toBe(456)
    expect(nextCtx.options!.commandAllowedTools).toContain(
      'Edit(~/.kode/settings.json)',
    )
  })
})

describe('Permission parity: matching rule patterns + skill prefixes', () => {
  test('commandAllowedTools participates in the same file permission engine (Read(~/**))', async () => {
    const filePath = join(homedir(), 'some-file.txt')
    const ctx = makeContext({
      options: { commandAllowedTools: ['Read(~/**)'] },
    })
    const result = await hasPermissionsToUseTool(
      FileReadTool,
      { file_path: filePath },
      ctx,
      createAssistantMessage(''),
    )
    expect(result.result).toBe(true)

    const ctxWithoutCommandTools = makeContext()
    const without = await hasPermissionsToUseTool(
      FileReadTool,
      { file_path: filePath },
      ctxWithoutCommandTools,
      createAssistantMessage(''),
    )
    expect(without.result).toBe(false)
  })

  test('FileReadTool matches allowedTools path patterns (Read(~/**))', async () => {
    const cfg = getCurrentProjectConfig()
    cfg.allowedTools = ['Read(~/**)']
    saveCurrentProjectConfig(cfg)

    const filePath = join(homedir(), 'some-file.txt')
    const ctx = makeContext()
    const result = await hasPermissionsToUseTool(
      FileReadTool,
      { file_path: filePath },
      ctx,
      createAssistantMessage(''),
    )
    expect(result.result).toBe(true)
  })

  test('FileEditTool matches allowedTools path patterns (Edit(~/**))', async () => {
    const cfg = getCurrentProjectConfig()
    cfg.allowedTools = ['Edit(~/**)']
    saveCurrentProjectConfig(cfg)

    const filePath = join(homedir(), 'some-file.txt')
    const ctx = makeContext()
    const result = await hasPermissionsToUseTool(
      FileEditTool,
      { file_path: filePath, old_string: 'a', new_string: 'b' },
      ctx,
      createAssistantMessage(''),
    )
    expect(result.result).toBe(true)
  })

  test('FileWriteTool matches allowedTools path patterns (Write(~/**))', async () => {
    const cfg = getCurrentProjectConfig()
    cfg.allowedTools = ['Write(~/**)']
    saveCurrentProjectConfig(cfg)

    const filePath = join(homedir(), 'some-file.txt')
    const ctx = makeContext()
    const result = await hasPermissionsToUseTool(
      FileWriteTool,
      { file_path: filePath, content: 'hi' },
      ctx,
      createAssistantMessage(''),
    )
    expect(result.result).toBe(true)
  })

  test('Read-only allowedTools does not grant write permissions', async () => {
    const cfg = getCurrentProjectConfig()
    cfg.allowedTools = ['Read(~/**)']
    saveCurrentProjectConfig(cfg)

    const filePath = join(homedir(), 'some-file.txt')
    const ctx = makeContext()
    const result = await hasPermissionsToUseTool(
      FileWriteTool,
      { file_path: filePath, content: 'hi' },
      ctx,
      createAssistantMessage(''),
    )
    expect(result.result).toBe(false)
  })

  test('SkillTool supports namespace prefix rules (Skill(ns:*))', async () => {
    const cfg = getCurrentProjectConfig()
    cfg.allowedTools = ['Skill(ms-office-suite:*)']
    saveCurrentProjectConfig(cfg)

    const ctx = makeContext()
    const result = await hasPermissionsToUseTool(
      SkillTool,
      { skill: 'ms-office-suite:pdf' },
      ctx,
      createAssistantMessage(''),
    )
    expect(result.result).toBe(true)
  })
})
