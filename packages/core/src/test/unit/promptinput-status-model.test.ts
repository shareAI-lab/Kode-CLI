import { describe, expect, test } from 'bun:test'
import { createAssistantMessage } from '#core/utils/messages'
import {
  buildPromptStatusLineInput,
  getPromptStatusLineUsage,
} from '#ui-ink/components/PromptInput/statusLineModel'
import { formatPromptTokenCount } from '#ui-ink/components/PromptInput/PromptInputView'
import {
  formatContextLimit,
  isRenderableContextLimit,
} from '#ui-ink/utils/tokenDisplay'

function assistantWithUsage(args: {
  input: number
  output: number
  cacheCreate?: number
  cacheRead?: number
  costUSD?: number
}) {
  const message = createAssistantMessage('ok')
  message.costUSD = args.costUSD ?? 0
  ;(message.message as unknown as { usage: Record<string, number> }).usage = {
    input_tokens: args.input,
    output_tokens: args.output,
    cache_creation_input_tokens: args.cacheCreate ?? 0,
    cache_read_input_tokens: args.cacheRead ?? 0,
  }
  return message
}

describe('PromptInput status line model', () => {
  test('summarizes assistant usage in one pass with latest usage as current', () => {
    const assistantWithoutUsage = createAssistantMessage('no usage metadata')
    assistantWithoutUsage.costUSD = 0.5
    const usage = getPromptStatusLineUsage([
      assistantWithoutUsage,
      assistantWithUsage({ input: 10, output: 5, costUSD: 1.25 }),
      assistantWithUsage({
        input: 20,
        output: 7,
        cacheRead: 3,
        costUSD: 2.5,
      }),
    ])

    expect(usage.totalInputTokens).toBe(30)
    expect(usage.totalOutputTokens).toBe(12)
    expect(usage.totalCostUSD).toBe(4.25)
    expect(usage.currentUsage).toMatchObject({
      input_tokens: 20,
      output_tokens: 7,
      cache_read_input_tokens: 3,
    })
  })

  test('builds a stable structured status-line input', () => {
    const input = buildPromptStatusLineInput({
      sessionId: 'session-1',
      transcriptPath: 'messages.jsonl',
      currentPwd: 'C:/repo',
      originalCwd: 'C:/repo',
      version: '1.2.3',
      outputStyleName: 'default',
      profile: {
        modelName: 'model-id',
        name: 'Model Name',
        provider: 'openai',
        contextLength: 1000,
      },
      usage: getPromptStatusLineUsage([
        assistantWithUsage({
          input: 199000,
          output: 1500,
          cacheCreate: 1,
        }),
      ]),
      currentContextTokens: 960,
      totalCostUSD: 1.25,
      totalDurationMs: 100,
      totalAPIDurationMs: 80,
      messageLogName: 'log',
      forkNumber: 2,
      mode: 'prompt',
      permissionMode: 'cautious',
      editorMode: 'vim',
      vimMode: 'NORMAL',
    }) as any

    expect(input.model).toEqual({
      id: 'model-id',
      display_name: 'Model Name',
    })
    expect(input.kode.conversation).toEqual({
      messageLogName: 'log',
      forkNumber: 2,
    })
    expect(input.kode.model.provider).toBe('openai')
    expect(input.context_window.current_context_tokens).toBe(960)
    expect(input.context_window.current_usage.input_tokens).toBe(199000)
    expect(input.context_window.used_percentage).toBe(96)
    expect(input.context_window.remaining_percentage).toBe(4)
    expect(input.exceeds_200k_tokens).toBe(false)
    expect(input.vim.mode).toBe('NORMAL')
  })

  test('formats million-token windows without k-only labels', () => {
    expect(formatPromptTokenCount(186000)).toBe('186k')
    expect(formatPromptTokenCount(1048576)).toBe('1.0M')
  })

  test('does not render implausible context limits as prompt windows', () => {
    expect(isRenderableContextLimit(1)).toBe(false)
    expect(formatContextLimit(1049)).toBeNull()
    expect(formatContextLimit(8000)).toBe('8k')
    expect(formatContextLimit(1048576)).toBe('1.0M')
  })
})
