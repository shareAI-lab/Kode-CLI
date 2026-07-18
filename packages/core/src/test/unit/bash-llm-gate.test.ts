import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __setLlmModuleLoaderForTests,
  formatBashLlmGateBlockMessage,
  runBashLlmSafetyGate,
} from '#core/safety/bash-gate/llmSafetyGate'

// Use data-loss commands that actually trigger LLM Gate
const TRIGGER_COMMAND = 'git reset --hard'
const TRIGGER_PROMPT = 'Reset git repository'

const originalConfigDir = process.env.KODE_CONFIG_DIR
const testConfigDir = mkdtempSync(join(tmpdir(), 'kode-bash-llm-gate-'))

beforeAll(() => {
  process.env.KODE_CONFIG_DIR = testConfigDir
})

afterAll(() => {
  if (originalConfigDir === undefined) delete process.env.KODE_CONFIG_DIR
  else process.env.KODE_CONFIG_DIR = originalConfigDir
  rmSync(testConfigDir, { recursive: true, force: true })
})

describe('Bash LLM intent gate', () => {
  test('runs for user bash mode (no bypass)', async () => {
    let calls = 0
    const result = await runBashLlmSafetyGate({
      command: TRIGGER_COMMAND,
      userPrompt: TRIGGER_PROMPT,
      description: '',
      platform: process.platform,
      commandSource: 'user_bash_mode',
      safeMode: false,
      runInBackground: false,
      willSandbox: true,
      sandboxRequired: false,
      cwd: process.cwd(),
      originalCwd: process.cwd(),
      query: async () => {
        calls++
        return 'ALLOW'
      },
    })
    expect(result.decision).toBe('allow')
    expect(calls).toBe(1)
  })

  test('does not trigger for non-data-loss commands', async () => {
    let calls = 0
    const result = await runBashLlmSafetyGate({
      command: 'sudo ls',
      userPrompt: 'List files with sudo',
      description: '',
      platform: process.platform,
      commandSource: 'agent_call',
      safeMode: false,
      runInBackground: false,
      willSandbox: true,
      sandboxRequired: false,
      cwd: process.cwd(),
      originalCwd: process.cwd(),
      query: async () => {
        calls++
        return 'ALLOW'
      },
    })
    expect(result.decision).toBe('allow')
    expect(calls).toBe(0) // Gate not called for non-data-loss command
  })

  test('parses ALLOW verdict', async () => {
    const result = await runBashLlmSafetyGate({
      command: TRIGGER_COMMAND,
      userPrompt: TRIGGER_PROMPT,
      description: '',
      platform: process.platform,
      commandSource: 'agent_call',
      safeMode: false,
      runInBackground: false,
      willSandbox: true,
      sandboxRequired: false,
      cwd: process.cwd(),
      originalCwd: process.cwd(),
      query: async () => `  ALLOW  \n(extra ignored)`,
    })
    expect(result.decision).toBe('allow')
  })

  test('parses BLOCK verdict with reason', async () => {
    const result = await runBashLlmSafetyGate({
      command: 'rm -rf /',
      userPrompt: 'Delete everything',
      description: '',
      platform: process.platform,
      commandSource: 'agent_call',
      safeMode: false,
      runInBackground: false,
      willSandbox: true,
      sandboxRequired: false,
      cwd: process.cwd(),
      originalCwd: process.cwd(),
      query: async () => `BLOCK: destructive`,
    })
    expect(result.decision).toBe('block')
    if (result.decision === 'block') {
      expect(result.verdict.summary).toBe('destructive')
    }
  })

  test('parses XML verdict output', async () => {
    const result = await runBashLlmSafetyGate({
      command: TRIGGER_COMMAND,
      userPrompt: TRIGGER_PROMPT,
      description: '',
      platform: process.platform,
      commandSource: 'agent_call',
      safeMode: false,
      runInBackground: false,
      willSandbox: true,
      sandboxRequired: false,
      cwd: process.cwd(),
      originalCwd: process.cwd(),
      query: async () =>
        `<decision>allow</decision>\n<reason>ok</reason>\n(ignored)`,
    })
    expect(result.decision).toBe('allow')
  })

  test('fails closed when model output is invalid', async () => {
    let calls = 0
    const result = await runBashLlmSafetyGate({
      command: TRIGGER_COMMAND,
      userPrompt: TRIGGER_PROMPT,
      description: '',
      platform: process.platform,
      commandSource: 'agent_call',
      safeMode: false,
      runInBackground: false,
      willSandbox: true,
      sandboxRequired: false,
      cwd: process.cwd(),
      originalCwd: process.cwd(),
      query: async () => {
        calls++
        return 'Here is my analysis:\n1) ...\n2) ...' // missing ALLOW/BLOCK
      },
    })

    expect(result.decision).toBe('error')
    // Retries: quick first, then main twice.
    expect(calls).toBe(3)
  })

  test('fails closed without retrying after unrecoverable API key errors', async () => {
    let calls = 0
    const result = await runBashLlmSafetyGate({
      command: TRIGGER_COMMAND,
      userPrompt: TRIGGER_PROMPT,
      description: '',
      platform: process.platform,
      commandSource: 'agent_call',
      safeMode: false,
      runInBackground: false,
      willSandbox: false,
      sandboxRequired: false,
      cwd: process.cwd(),
      originalCwd: process.cwd(),
      query: async () => {
        calls++
        throw new Error('LLM gate model error: API_ERROR: Invalid API key')
      },
    })

    expect(result.decision).toBe('error')
    expect(calls).toBe(1)
    if (result.decision === 'error') {
      expect(result.errorType).toBe('api')
      expect(result.canFailOpen).toBe(false)
    }
  })

  test('fails closed without retrying after raw provider auth errors', async () => {
    let calls = 0
    const result = await runBashLlmSafetyGate({
      command: TRIGGER_COMMAND,
      userPrompt: TRIGGER_PROMPT,
      description: '',
      platform: process.platform,
      commandSource: 'agent_call',
      safeMode: false,
      runInBackground: false,
      willSandbox: false,
      sandboxRequired: false,
      cwd: process.cwd(),
      originalCwd: process.cwd(),
      query: async () => {
        calls++
        throw new Error('Invalid API key')
      },
    })

    expect(result.decision).toBe('error')
    expect(calls).toBe(1)
    if (result.decision === 'error') {
      expect(result.errorType).toBe('api')
      expect(result.canFailOpen).toBe(false)
    }
  })

  test('formats non-Zod errors in error path (Error instance)', async () => {
    const result = await runBashLlmSafetyGate({
      command: TRIGGER_COMMAND,
      userPrompt: TRIGGER_PROMPT,
      description: '',
      platform: process.platform,
      commandSource: 'agent_call',
      safeMode: false,
      runInBackground: false,
      willSandbox: false,
      sandboxRequired: false,
      cwd: process.cwd(),
      originalCwd: process.cwd(),
      query: async () => {
        throw new Error('boom')
      },
    })
    expect(result.decision).toBe('error')
    if (result.decision === 'error') {
      expect(result.error).toBe('boom')
    }
  })

  test('formats non-Zod errors in error path (non-Error value)', async () => {
    const result = await runBashLlmSafetyGate({
      command: TRIGGER_COMMAND,
      userPrompt: TRIGGER_PROMPT,
      description: '',
      platform: process.platform,
      commandSource: 'agent_call',
      safeMode: false,
      runInBackground: false,
      willSandbox: false,
      sandboxRequired: false,
      cwd: process.cwd(),
      originalCwd: process.cwd(),
      query: async () => {
        throw 123
      },
    })
    expect(result.decision).toBe('error')
    if (result.decision === 'error') {
      expect(result.error).toBe('123')
    }
  })

  test('uses defaultGateQuery (mocked) when no query is provided', async () => {
    try {
      __setLlmModuleLoaderForTests(async () => ({
        queryLLM: async () => ({
          message: {
            content: [
              { type: 'not_text', text: 'ignored' },
              {
                type: 'text',
                text: 'ALLOW',
              },
            ],
          },
        }),
        API_ERROR_MESSAGE_PREFIX: 'API_ERROR: ',
      }))

      const result = await runBashLlmSafetyGate({
        command: TRIGGER_COMMAND,
        userPrompt: TRIGGER_PROMPT,
        description: '',
        platform: process.platform,
        commandSource: 'agent_call',
        safeMode: false,
        runInBackground: false,
        willSandbox: true,
        sandboxRequired: false,
        cwd: process.cwd(),
        originalCwd: process.cwd(),
      })
      expect(result.decision).toBe('allow')
    } finally {
      __setLlmModuleLoaderForTests(null)
    }
  })

  test('defaultGateQuery surfaces API error messages as gate errors', async () => {
    try {
      let calls = 0
      __setLlmModuleLoaderForTests(async () => ({
        queryLLM: async () => {
          calls++
          return {
            isApiErrorMessage: true,
            message: {
              content: [{ type: 'text', text: 'API_ERROR: Invalid API key' }],
            },
          }
        },
        API_ERROR_MESSAGE_PREFIX: 'API_ERROR: ',
      }))

      const result = await runBashLlmSafetyGate({
        command: TRIGGER_COMMAND,
        userPrompt: TRIGGER_PROMPT,
        description: '',
        platform: process.platform,
        commandSource: 'agent_call',
        safeMode: false,
        runInBackground: false,
        willSandbox: false,
        sandboxRequired: false,
        cwd: process.cwd(),
        originalCwd: process.cwd(),
      })
      expect(result.decision).toBe('error')
      expect(calls).toBe(1)
      if (result.decision === 'error') {
        expect(result.error).toContain('LLM gate model error:')
        expect(result.errorType).toBe('api')
      }
    } finally {
      __setLlmModuleLoaderForTests(null)
    }
  })

  test('formats block message with corrected command', () => {
    const msg = formatBashLlmGateBlockMessage({
      action: 'block',
      summary: 'Dangerous',
    })
    expect(msg).toContain('Blocked by LLM intent gate: Dangerous')
  })

  test('formats block message without corrected command', () => {
    const msg = formatBashLlmGateBlockMessage({
      action: 'block',
      summary: 'Dangerous',
    })
    expect(msg).toContain('Blocked by LLM intent gate: Dangerous')
  })
})
