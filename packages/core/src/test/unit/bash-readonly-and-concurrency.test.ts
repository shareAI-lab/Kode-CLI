import { describe, expect, test } from 'bun:test'
import { __ToolUseQueueForTests } from '@kode/engine/pipeline/tool-use-queue'
import { z } from 'zod'
import type { Tool } from '#core/tooling/Tool'
import { createAssistantMessage } from '#core/utils/messages'
import { isBashCommandReadOnly } from '@kode/permissions/bash'
import { BashTool } from '#tools/tools/system/BashTool/BashTool'
import type { CanUseToolFn } from '#core/permissions/canUseTool'
import type { ExtendedToolUseContext } from '#core/query'
import type { ToolUseLikeBlockParam } from '#core/utils/anthropic'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeBashLikeTool(options: { callImpl: Tool['call'] }): Tool {
  const inputSchema = z.strictObject({
    command: z.string(),
  })

  return {
    name: 'Bash',
    inputSchema,
    async prompt() {
      return ''
    },
    async isEnabled() {
      return true
    },
    isReadOnly(input?: any) {
      return (
        typeof input?.command === 'string' &&
        isBashCommandReadOnly(input.command)
      )
    },
    isConcurrencySafe(input?: any) {
      return this.isReadOnly(input)
    },
    needsPermissions() {
      return false
    },
    renderResultForAssistant() {
      return ''
    },
    renderToolUseMessage() {
      return ''
    },
    call: options.callImpl,
  } satisfies Tool
}

function makeToolUse(
  id: string,
  input: { command: string },
): ToolUseLikeBlockParam {
  return { id, name: 'Bash', input, type: 'tool_use' }
}

describe('Bash read-only detection + scheduler concurrency parity', () => {
  test('read-only detector is conservative for complex commands', () => {
    for (const command of [
      'pwd',
      'ls -la',
      'git status',
      'rg -n verification packages/engine',
      "sed -n '1,80p' packages/engine/src/message-pipeline.ts",
      'find packages -name *.ts',
      'ls | grep package',
      'rg -n verification packages && git diff --check',
      'rg -n verification packages 2>/dev/null | head -20',
      'git -C packages/engine status --short',
      'LC_ALL=C sort package.json',
    ]) {
      expect(isBashCommandReadOnly(command)).toBe(true)
    }

    for (const command of [
      'cat foo > bar',
      'sed -i.bak s/old/new/ file.ts',
      'find packages -name *.ts -delete',
      'find packages -exec touch {} ;',
      'rg --pre ./transform.sh pattern .',
      'fd -x touch',
      'sort input.txt -o output.txt',
      'yq -i .name=changed package.yaml',
      'git -c core.pager=cat status',
      'git diff --ext-diff',
      'git diff --output=changes.patch',
      'git cat-file --filters HEAD:file.ts',
      'tree -o tree.txt',
      'fd --exec=touch',
      'sed --in-place=.bak s/old/new/ file.ts',
      'ls & pwd',
      'cat $(touch changed.txt)',
    ]) {
      expect(isBashCommandReadOnly(command)).toBe(false)
    }
  })

  test('BashTool concurrency-safe matches read-only detection', () => {
    expect(BashTool.isReadOnly({ command: 'pwd' })).toBe(true)
    expect(BashTool.isConcurrencySafe({ command: 'pwd' })).toBe(true)
    expect(BashTool.isReadOnly({ command: 'cat foo > bar' })).toBe(false)
    expect(BashTool.isConcurrencySafe({ command: 'cat foo > bar' })).toBe(false)
  })

  test('two read-only Bash tool uses can start concurrently', async () => {
    const started: string[] = []
    const gateA = deferred()
    const gateB = deferred()

    const Bash = makeBashLikeTool({
      callImpl: async function* (_input: any, ctx: any) {
        started.push(ctx.toolUseId)
        if (ctx.toolUseId === 'a') await gateA.promise
        if (ctx.toolUseId === 'b') await gateB.promise
        yield { type: 'result', data: { ok: true }, resultForAssistant: 'ok' }
      },
    })

    const toolUseContext: ExtendedToolUseContext = {
      abortController: new AbortController(),
      messageId: 'm',
      readFileTimestamps: {},
      setToolJSX: () => {},
      options: {
        tools: [Bash],
        commands: [],
        forkNumber: 0,
        messageLogName: 'bash-readonly-concurrency',
        verbose: false,
        safeMode: false,
        maxThinkingTokens: 0,
      },
    }

    const canUseTool: CanUseToolFn = async () => ({ result: true })

    const queue = new __ToolUseQueueForTests({
      toolDefinitions: [Bash],
      canUseTool,
      toolUseContext,
      siblingToolUseIDs: new Set(['a', 'b']),
    })

    const assistantMessage = createAssistantMessage('tools')

    let consumePromise: Promise<any[]> | null = null
    try {
      queue.addTool(makeToolUse('a', { command: 'pwd' }), assistantMessage)
      queue.addTool(makeToolUse('b', { command: 'pwd' }), assistantMessage)

      consumePromise = (async () => {
        const out: any[] = []
        for await (const msg of queue.getRemainingResults()) out.push(msg)
        return out
      })()

      await new Promise(r => setTimeout(r, 0))
      expect(new Set(started)).toEqual(new Set(['a', 'b']))

      gateA.resolve()
      gateB.resolve()
      await consumePromise
    } finally {
      gateA.resolve()
      gateB.resolve()
      if (consumePromise) await consumePromise
    }
  })

  test('non-read-only Bash tool use blocks subsequent Bash tool uses', async () => {
    const started: string[] = []
    const gateA = deferred()
    const gateB = deferred()

    const Bash = makeBashLikeTool({
      callImpl: async function* (_input: any, ctx: any) {
        started.push(ctx.toolUseId)
        if (ctx.toolUseId === 'a') await gateA.promise
        if (ctx.toolUseId === 'b') await gateB.promise
        yield { type: 'result', data: { ok: true }, resultForAssistant: 'ok' }
      },
    })

    const toolUseContext: ExtendedToolUseContext = {
      abortController: new AbortController(),
      messageId: 'm',
      readFileTimestamps: {},
      setToolJSX: () => {},
      options: {
        tools: [Bash],
        commands: [],
        forkNumber: 0,
        messageLogName: 'bash-readonly-barrier',
        verbose: false,
        safeMode: false,
        maxThinkingTokens: 0,
      },
    }

    const canUseTool: CanUseToolFn = async () => ({ result: true })

    const queue = new __ToolUseQueueForTests({
      toolDefinitions: [Bash],
      canUseTool,
      toolUseContext,
      siblingToolUseIDs: new Set(['a', 'b']),
    })

    const assistantMessage = createAssistantMessage('tools')

    let consumePromise: Promise<any[]> | null = null
    try {
      queue.addTool(
        makeToolUse('a', { command: 'cat foo > bar' }),
        assistantMessage,
      )
      queue.addTool(makeToolUse('b', { command: 'pwd' }), assistantMessage)

      consumePromise = (async () => {
        const out: any[] = []
        for await (const msg of queue.getRemainingResults()) out.push(msg)
        return out
      })()

      await new Promise(r => setTimeout(r, 0))
      expect(started).toEqual(['a'])

      gateA.resolve()
      await new Promise(r => setTimeout(r, 0))
      expect(started).toEqual(['a', 'b'])

      gateB.resolve()
      await consumePromise
    } finally {
      gateA.resolve()
      gateB.resolve()
      if (consumePromise) await consumePromise
    }
  })
})
