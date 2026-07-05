import { describe, expect, test } from 'bun:test'
import { createInterface } from 'node:readline'
import { PassThrough } from 'node:stream'
import { KodeAgentStructuredStdio } from '#protocol/utils/kodeAgentStructuredStdio'
import { runKodeAgentStreamJsonSession } from '#protocol/utils/kodeAgentStreamJsonSession'
import {
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createUserMessage,
} from '#core/utils/messages'
import type { Message } from '#core/query'
import type { ToolUseContext } from '#core/tooling/Tool'

type UUID = `${string}-${string}-${string}-${string}-${string}`

function isUuidValue(value: string): value is UUID {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value.trim(),
  )
}

function makeLineReader(
  rl: ReturnType<typeof createInterface>,
): () => Promise<string> {
  const queue: string[] = []
  let resolveNext: ((line: string) => void) | null = null

  rl.on('line', line => {
    if (resolveNext) {
      const resolve = resolveNext
      resolveNext = null
      resolve(line)
      return
    }
    queue.push(line)
  })

  return async () => {
    if (queue.length > 0) return queue.shift()!
    return await new Promise<string>(resolve => {
      resolveNext = resolve
    })
  }
}

describe('stream-json persistent session', () => {
  test('replay-user-messages echoes user lines and suppresses duplicate uuid execution', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const rlOut = createInterface({ input: stdout })
    const nextLine = makeLineReader(rlOut)

    const structured = new KodeAgentStructuredStdio(stdin, stdout)
    structured.start()

    let queryCalls = 0
    const query = async function* (
      _messages: Message[],
      _systemPrompt: string[],
      _context: { [k: string]: string },
      _canUseTool: unknown,
      _toolUseContext: ToolUseContext,
    ): AsyncGenerator<Message, void> {
      queryCalls += 1
      yield createAssistantMessage(`turn:${queryCalls}`)
    }

    const canUseTool = async () => ({ result: true })

    const toolUseContextBase = { messageId: undefined, readFileTimestamps: {} }

    const sessionPromise = runKodeAgentStreamJsonSession<
      Message,
      ToolUseContext
    >({
      structured,
      query,
      makeUserMessage: (content, uuidOverride) => {
        const text =
          typeof content === 'string' ? content : JSON.stringify(content)
        const msg = createUserMessage(text)
        if (uuidOverride && isUuidValue(uuidOverride)) {
          msg.uuid = uuidOverride
        }
        return msg
      },
      writeSdkLine: obj => {
        stdout.write(JSON.stringify(obj) + '\n')
      },
      sessionId: 'sess_test',
      systemPrompt: [],
      context: {},
      canUseTool,
      toolUseContextBase,
      replayUserMessages: true,
      getTotalCostUsd: () => 0,
    })

    stdin.write(
      JSON.stringify({
        type: 'user',
        uuid: '11111111-1111-1111-1111-111111111111',
        message: { role: 'user', content: 'hi' },
      }) + '\n',
    )

    const user1 = JSON.parse(await nextLine())
    expect(user1.type).toBe('user')
    expect(user1.uuid).toBe('11111111-1111-1111-1111-111111111111')

    const assistant1 = JSON.parse(await nextLine())
    expect(assistant1.type).toBe('assistant')

    const result1 = JSON.parse(await nextLine())
    expect(result1.type).toBe('result')
    expect(result1.is_error).toBe(false)

    stdin.write(
      JSON.stringify({
        type: 'user',
        uuid: '22222222-2222-2222-2222-222222222222',
        message: { role: 'user', content: 'yo' },
      }) + '\n',
    )

    const user2 = JSON.parse(await nextLine())
    expect(user2.type).toBe('user')
    expect(user2.uuid).toBe('22222222-2222-2222-2222-222222222222')

    const assistant2 = JSON.parse(await nextLine())
    expect(assistant2.type).toBe('assistant')

    const result2 = JSON.parse(await nextLine())
    expect(result2.type).toBe('result')
    expect(result2.is_error).toBe(false)

    // Duplicate uuid should be acknowledged (user replay) but not re-executed.
    stdin.write(
      JSON.stringify({
        type: 'user',
        uuid: '11111111-1111-1111-1111-111111111111',
        message: { role: 'user', content: 'hi' },
      }) + '\n',
    )

    const dup = JSON.parse(await nextLine())
    expect(dup.type).toBe('user')
    expect(dup.uuid).toBe('11111111-1111-1111-1111-111111111111')

    stdin.end()
    await sessionPromise
    expect(queryCalls).toBe(2)

    rlOut.close()
    stdout.end()
  })

  test('without replay-user-messages, user lines are not emitted', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const rlOut = createInterface({ input: stdout })
    const nextLine = makeLineReader(rlOut)

    const structured = new KodeAgentStructuredStdio(stdin, stdout)
    structured.start()

    let queryCalls = 0
    const query = async function* (
      _messages: Message[],
      _systemPrompt: string[],
      _context: { [k: string]: string },
      _canUseTool: unknown,
      _toolUseContext: ToolUseContext,
    ): AsyncGenerator<Message, void> {
      queryCalls += 1
      yield createAssistantMessage(`turn:${queryCalls}`)
    }

    const canUseTool = async () => ({ result: true })

    const toolUseContextBase = { messageId: undefined, readFileTimestamps: {} }

    const sessionPromise = runKodeAgentStreamJsonSession<
      Message,
      ToolUseContext
    >({
      structured,
      query,
      makeUserMessage: (content, uuidOverride) => {
        const text =
          typeof content === 'string' ? content : JSON.stringify(content)
        const msg = createUserMessage(text)
        if (uuidOverride && isUuidValue(uuidOverride)) {
          msg.uuid = uuidOverride
        }
        return msg
      },
      writeSdkLine: obj => {
        stdout.write(JSON.stringify(obj) + '\n')
      },
      sessionId: 'sess_test',
      systemPrompt: [],
      context: {},
      canUseTool,
      toolUseContextBase,
      replayUserMessages: false,
      getTotalCostUsd: () => 0,
    })

    stdin.write(
      JSON.stringify({
        type: 'user',
        uuid: '11111111-1111-1111-1111-111111111111',
        message: { role: 'user', content: 'hi' },
      }) + '\n',
    )

    const assistant1 = JSON.parse(await nextLine())
    expect(assistant1.type).toBe('assistant')

    const result1 = JSON.parse(await nextLine())
    expect(result1.type).toBe('result')
    expect(result1.is_error).toBe(false)

    stdin.end()
    await sessionPromise
    expect(queryCalls).toBe(1)

    rlOut.close()
    stdout.end()
  })

  test('API error assistant messages degrade result subtype without blocking the session', async () => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const rlOut = createInterface({ input: stdout })
    const nextLine = makeLineReader(rlOut)

    const structured = new KodeAgentStructuredStdio(stdin, stdout)
    structured.start()

    let queryCalls = 0
    const query = async function* (): AsyncGenerator<Message, void> {
      queryCalls += 1
      if (queryCalls === 1) {
        yield createAssistantAPIErrorMessage('API Error: provider unavailable')
        return
      }
      yield createAssistantMessage(`turn:${queryCalls}`)
    }

    const canUseTool = async () => ({ result: true })
    const toolUseContextBase = { messageId: undefined, readFileTimestamps: {} }

    const sessionPromise = runKodeAgentStreamJsonSession<
      Message,
      ToolUseContext
    >({
      structured,
      query,
      makeUserMessage: content => {
        const text =
          typeof content === 'string' ? content : JSON.stringify(content)
        return createUserMessage(text)
      },
      writeSdkLine: obj => {
        stdout.write(JSON.stringify(obj) + '\n')
      },
      sessionId: 'sess_test',
      systemPrompt: [],
      context: {},
      canUseTool,
      toolUseContextBase,
      replayUserMessages: false,
      getTotalCostUsd: () => 0,
    })

    stdin.write(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'hi' },
      }) + '\n',
    )

    const assistant = JSON.parse(await nextLine())
    expect(assistant.type).toBe('assistant')

    const result = JSON.parse(await nextLine())
    expect(result.type).toBe('result')
    expect(result.subtype).toBe('error_during_execution')
    expect(result.is_error).toBe(true)

    stdin.write(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'again' },
      }) + '\n',
    )

    const assistant2 = JSON.parse(await nextLine())
    expect(assistant2.type).toBe('assistant')

    const result2 = JSON.parse(await nextLine())
    expect(result2.type).toBe('result')
    expect(result2.subtype).toBe('success')
    expect(result2.is_error).toBe(false)

    stdin.end()
    await sessionPromise
    expect(queryCalls).toBe(2)

    rlOut.close()
    stdout.end()
  })
})
