import { afterEach, describe, expect, test } from 'bun:test'
import React from 'react'

import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js'

import { KeypressProvider } from '#ui-ink/contexts/KeypressContext'
import { ElicitationRequest } from '#ui-ink/components/mcp/ElicitationRequest'
import type { McpElicitationPrompt } from '#cli-services/mcpCapabilities'

import { createInkHarnessManager, createInkTestHarness } from './inkTestHarness'

const KEY = {
  up: '\u001b[A',
  down: '\u001b[B',
  right: '\u001b[C',
  left: '\u001b[D',
  enter: '\r',
  escape: '\u001b',
  tab: '\t',
  backspace: '\u007f',
} as const

// CI runs this on ubuntu, macOS and Windows, so waits are condition-based
// rather than fixed sleeps: a slow runner must not turn a passing interaction
// into a flake. The keypress parser buffers multi-character chunks briefly
// (paste disambiguation), which is why each step waits for its own effect.
const TIMEOUT_MS = 10_000
const ESC_TIMEOUT_MS = 2_000
// Must exceed the parser's FAST_RETURN_TIMEOUT (30ms) with margin for CI.
const RETURN_GAP_MS = 120

type Waiter = {
  stdin: { write: (s: string) => void }
  wait: (ms: number) => Promise<void>
  getOutput: () => string
}

async function waitFor(
  harness: Waiter,
  predicate: () => boolean,
  timeoutMs = TIMEOUT_MS,
  what = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await harness.wait(10)
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${what}. Output: ${JSON.stringify(
      harness.getOutput(),
    )}`,
  )
}

/** Write input and wait until it is observable in the rendered output. */
async function type(
  harness: Waiter,
  text: string,
  expected: string,
  timeoutMs = TIMEOUT_MS,
): Promise<void> {
  harness.stdin.write(text)
  await waitFor(
    harness,
    () => harness.getOutput().includes(expected),
    timeoutMs,
    `output to contain ${JSON.stringify(expected)}`,
  )
}

/** Write input whose only effect is resolving the elicitation. */
async function submit(
  harness: Waiter,
  text: string,
  results: unknown[],
): Promise<void> {
  // The keypress parser treats a `\r` arriving within FAST_RETURN_TIMEOUT
  // (30ms) of the previous keystroke as pasted text, not as Enter. Real typing
  // never hits this, but a synthetic write does, so leave a deliberate gap.
  await harness.wait(RETURN_GAP_MS)
  harness.stdin.write(text)
  await waitFor(harness, () => results.length > 0, TIMEOUT_MS, 'a result')
}

const harnessManager = createInkHarnessManager()

afterEach(async () => {
  await harnessManager.cleanup()
})

function makePrompt(schema: unknown, message = 'Pick one') {
  const results: ElicitResult[] = []
  const prompt = {
    serverName: 'test-server',
    request: {
      method: 'elicitation/create',
      params: { message, requestedSchema: schema },
    },
    resolve: (result: ElicitResult) => results.push(result),
  } as unknown as McpElicitationPrompt

  return { prompt, results }
}

function renderPrompt(prompt: McpElicitationPrompt) {
  const harness = createInkTestHarness(
    <KeypressProvider>
      <ElicitationRequest prompt={prompt} onDone={() => {}} />
    </KeypressProvider>,
  )
  harnessManager.track(harness)
  return harness
}

const stringSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Your name' },
  },
}

describe('MCP elicitation TUI', () => {
  test('renders the server message, field titles and key hints', async () => {
    const { prompt } = makePrompt(stringSchema, 'What is your name?')
    const harness = renderPrompt(prompt)
    await harness.wait(60)

    const output = harness.getOutput()
    expect(output).toContain('test-server (MCP) requests input')
    expect(output).toContain('What is your name?')
    expect(output).toContain('Your name')
    expect(output).toContain('Esc to decline')
  })

  test('typing then Enter accepts with the collected content', async () => {
    const { prompt, results } = makePrompt(stringSchema)
    const harness = renderPrompt(prompt)
    await harness.wait(60)

    await type(harness, 'ada', 'ada')
    expect(harness.getOutput()).toContain('ada')

    await submit(harness, KEY.enter, results)

    expect(results).toEqual([{ action: 'accept', content: { name: 'ada' } }])
  })

  test('Esc declines without submitting content', async () => {
    const { prompt, results } = makePrompt(stringSchema)
    const harness = renderPrompt(prompt)
    await harness.wait(60)

    await submit(harness, KEY.escape, results)

    expect(results).toEqual([{ action: 'decline' }])
  })

  test('left/right move the caret so a typo can be fixed in place', async () => {
    const { prompt, results } = makePrompt(stringSchema)
    const harness = renderPrompt(prompt)
    await harness.wait(60)

    await type(harness, 'ac', 'ac')
    await type(harness, KEY.left, 'a▏c')
    await type(harness, 'b', 'ab▏c')

    await submit(harness, KEY.enter, results)

    expect(results).toEqual([{ action: 'accept', content: { name: 'abc' } }])
  })

  test('backspace deletes at the caret rather than the end', async () => {
    const { prompt, results } = makePrompt(stringSchema)
    const harness = renderPrompt(prompt)
    await harness.wait(60)

    await type(harness, 'abc', 'abc')
    await type(harness, KEY.left, 'ab▏c')
    await type(harness, KEY.backspace, 'a▏c')
    await submit(harness, KEY.enter, results)

    expect(results).toEqual([{ action: 'accept', content: { name: 'ac' } }])
  })

  test('paste inserts the whole block at the caret', async () => {
    const { prompt, results } = makePrompt(stringSchema)
    const harness = renderPrompt(prompt)
    await harness.wait(60)

    await type(harness, '\u001b[200~pasted value\u001b[201~', 'pasted value')
    await submit(harness, KEY.enter, results)

    expect(results).toEqual([
      { action: 'accept', content: { name: 'pasted value' } },
    ])
  })

  test('Tab moves focus between fields', async () => {
    const { prompt, results } = makePrompt({
      type: 'object',
      properties: {
        first: { type: 'string', title: 'First' },
        second: { type: 'string', title: 'Second' },
      },
    })
    const harness = renderPrompt(prompt)
    await harness.wait(60)

    await type(harness, 'one', 'one')
    await type(harness, KEY.tab, '❯ Second')
    await type(harness, 'two', 'two')
    await submit(harness, KEY.enter, results)

    expect(results).toEqual([
      { action: 'accept', content: { first: 'one', second: 'two' } },
    ])
  })

  test('enums cycle with arrow keys and booleans toggle', async () => {
    const { prompt, results } = makePrompt({
      type: 'object',
      properties: {
        color: { type: 'string', title: 'Color', enum: ['red', 'green'] },
        loud: { type: 'boolean', title: 'Loud' },
      },
    })
    const harness = renderPrompt(prompt)
    await harness.wait(60)

    await type(harness, KEY.right, 'green')
    await type(harness, KEY.down, '❯ Loud')
    await type(harness, KEY.right, '[true]')
    await submit(harness, KEY.enter, results)

    expect(results).toEqual([
      { action: 'accept', content: { color: 'green', loud: true } },
    ])
  })

  test('numbers are submitted as numbers, not strings', async () => {
    const { prompt, results } = makePrompt({
      type: 'object',
      properties: {
        age: { type: 'number', title: 'Age' },
      },
    })
    const harness = renderPrompt(prompt)
    await harness.wait(60)

    await type(harness, '42', '42')
    await submit(harness, KEY.enter, results)

    expect(results).toEqual([{ action: 'accept', content: { age: 42 } }])
  })

  /**
   * A hostile server must not be able to drive the terminal through the
   * elicitation form: no clear-screen, no cursor moves, no forged UI.
   *
   * Ink emits its own layout escapes (`[2K`, `[1A`, `[G`, SGR), so this test
   * only asserts on sequences Ink never produces.
   */
  test('server-controlled text cannot inject terminal escape sequences', async () => {
    const evil =
      'normal \u001b[2J\u001b[1;31mFORGED\u001b[0m \u001b]0;title\u0007 tail'
    const { prompt } = makePrompt(
      {
        type: 'object',
        properties: {
          field: {
            type: 'string',
            title: 'ti\u001b]0;pwned\u0007tle',
            description: 'de\u001b]8;;http://evil\u001b\\sc',
          },
        },
      },
      evil,
    )

    // Render a benign prompt first so the raw listener is attached before the
    // server-controlled text is emitted.
    const harness = createInkTestHarness(
      <KeypressProvider>
        <ElicitationRequest
          prompt={makePrompt(stringSchema).prompt}
          onDone={() => {}}
        />
      </KeypressProvider>,
    )
    harnessManager.track(harness)

    let raw = ''
    harness.stdout.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8')
    })

    harness.rerender(
      <KeypressProvider>
        <ElicitationRequest prompt={prompt} onDone={() => {}} />
      </KeypressProvider>,
    )
    await harness.wait(60)

    // None of the injected sequences may appear anywhere in the byte stream.
    expect(raw).not.toContain('\u001b[2J')
    expect(raw).not.toContain('\u001b[1;31m')
    expect(raw).not.toContain('\u001b]0;')
    expect(raw).not.toContain('\u001b]8;;')

    // The visible text survives, with the escapes removed from inside it.
    const output = harness.getOutput()
    expect(output).toContain('normal')
    expect(output).toContain('FORGED')
    expect(output).toContain('tail')
    expect(output).toContain('title')
    expect(output).toContain('desc')
  })

  /**
   * URL mode: no form, just the link. Kode deliberately does not open it.
   */
  test('URL-mode elicitation shows the link and accepts on Enter', async () => {
    const results: ElicitResult[] = []
    const prompt = {
      serverName: 'auth-server',
      request: {
        method: 'elicitation/create',
        params: {
          mode: 'url',
          message: 'Authorize access',
          elicitationId: 'elicit-1',
          url: 'https://example.com/authorize?token=abc',
        },
      },
      resolve: (result: ElicitResult) => results.push(result),
    } as unknown as McpElicitationPrompt

    const harness = renderPrompt(prompt)
    await harness.wait(60)

    const output = harness.getOutput()
    expect(output).toContain('Authorize access')
    expect(output).toContain('https://example.com/authorize?token=abc')
    expect(output).toContain('Enter when done')
    expect(output).not.toContain('Type to edit')

    await submit(harness, KEY.enter, results)

    expect(results).toMatchObject([{ action: 'accept' }])
  })

  test('URL-mode elicitation sanitizes the server-supplied link', async () => {
    const { prompt } = makePrompt({ type: 'object', properties: {} })
    const urlPrompt = {
      ...prompt,
      request: {
        method: 'elicitation/create',
        params: {
          mode: 'url',
          message: 'go',
          elicitationId: 'elicit-2',
          url: 'https://example.com/\u001b]0;pwned\u0007a',
        },
      },
    } as unknown as McpElicitationPrompt

    const harness = renderPrompt(urlPrompt)
    await harness.wait(60)

    const output = harness.getOutput()
    expect(output).toContain('https://example.com/')
    expect(output).not.toContain('\u001b]0;')
  })

  test('Esc declines URL-mode elicitation', async () => {
    const results: ElicitResult[] = []
    const prompt = {
      serverName: 'auth-server',
      request: {
        method: 'elicitation/create',
        params: {
          mode: 'url',
          message: 'Authorize access',
          elicitationId: 'elicit-3',
          url: 'https://example.com/authorize',
        },
      },
      resolve: (result: ElicitResult) => results.push(result),
    } as unknown as McpElicitationPrompt

    const harness = renderPrompt(prompt)
    await harness.wait(60)

    await submit(harness, KEY.escape, results)

    expect(results).toEqual([{ action: 'decline' }])
  })
})

describe('MCP elicitation schema defaults', () => {
  /**
   * The SDK only applies defaults to *undefined* values, and this form always
   * submits a value, so a server default that is not prefilled here is lost.
   */
  test('server-provided defaults are prefilled and submitted', async () => {
    const { prompt, results } = makePrompt({
      type: 'object',
      properties: {
        branch: { type: 'string', title: 'Branch', default: 'main' },
        retries: { type: 'integer', title: 'Retries', default: 3 },
        force: { type: 'boolean', title: 'Force', default: true },
        color: {
          type: 'string',
          title: 'Color',
          enum: ['red', 'green'],
          default: 'green',
        },
      },
    })
    const harness = renderPrompt(prompt)
    await harness.wait(60)

    const output = harness.getOutput()
    expect(output).toContain('main')
    expect(output).toContain('3')
    expect(output).toContain('[true]')
    expect(output).toContain('green')

    // Submitting untouched keeps the defaults (they are real values, not holes).
    await submit(harness, KEY.enter, results)

    expect(results).toEqual([
      {
        action: 'accept',
        content: { branch: 'main', retries: 3, force: true, color: 'green' },
      },
    ])
  })

  test('a user edit overrides the default', async () => {
    const { prompt, results } = makePrompt({
      type: 'object',
      properties: {
        branch: { type: 'string', title: 'Branch', default: 'main' },
      },
    })
    const harness = renderPrompt(prompt)
    await harness.wait(60)

    // Clear the prefilled value, then type a replacement. Expectations must be
    // caret states: 'mai'/'ma'/'m' are prefixes of 'main' and would match the
    // prefilled value immediately, making the waits vacuous.
    await type(harness, KEY.backspace, 'mai▏')
    await type(harness, KEY.backspace, 'ma▏')
    await type(harness, KEY.backspace, 'm▏')
    await type(harness, KEY.backspace, ': ▏')
    await type(harness, 'dev', 'dev')
    await submit(harness, KEY.enter, results)

    expect(results).toEqual([{ action: 'accept', content: { branch: 'dev' } }])
  })
})
