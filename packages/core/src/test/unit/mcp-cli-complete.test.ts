import { afterEach, describe, expect, test } from 'bun:test'

import { __setMcpClientsForTests } from '#core/mcp/client'
import {
  __resetMcpRootsForTests,
  __setMcpRootsTrustOverrideForTests,
} from '#core/mcp/client/roots'
import {
  __resetMcpSamplingForTests,
  __setMcpSamplingEnabledForTests,
} from '#core/mcp/client/sampling'
import { runMcpCli } from '#host-cli/entrypoints/mcpCli'

async function captureMcpCli(argv: string[]): Promise<{
  code: number
  stdout: string
  stderr: string
}> {
  let stdout = ''
  let stderr = ''
  const originalStdoutWrite = process.stdout.write
  const originalStderrWrite = process.stderr.write
  const originalExit = process.exit
  const originalConsoleLog = console.log
  const originalConsoleError = console.error

  ;(process.stdout.write as unknown as (...args: unknown[]) => boolean) = (
    chunk,
    ...args
  ) => {
    stdout += String(chunk)
    const callback = args.find(arg => typeof arg === 'function') as
      (() => void) | undefined
    callback?.()
    return true
  }
  ;(process.stderr.write as unknown as (...args: unknown[]) => boolean) = (
    chunk,
    ...args
  ) => {
    stderr += String(chunk)
    const callback = args.find(arg => typeof arg === 'function') as
      (() => void) | undefined
    callback?.()
    return true
  }
  ;(process as any).exit = ((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`)
  }) as typeof process.exit
  console.log = (...args: unknown[]) => {
    stdout += `${args.map(String).join(' ')}\n`
  }
  console.error = (...args: unknown[]) => {
    stderr += `${args.map(String).join(' ')}\n`
  }

  try {
    const code = await runMcpCli({ argv, cwd: process.cwd() })
    return { code, stdout, stderr }
  } finally {
    process.stdout.write = originalStdoutWrite
    process.stderr.write = originalStderrWrite
    process.exit = originalExit
    console.log = originalConsoleLog
    console.error = originalConsoleError
    process.exitCode = undefined
  }
}

describe('mcp-cli complete', () => {
  afterEach(() => {
    __setMcpClientsForTests(null)
    __resetMcpRootsForTests()
  })

  test('prints MCP completion values from a prompt reference', async () => {
    const requests: unknown[] = []
    const client: any = {
      complete: async (params: unknown) => {
        requests.push(params)
        return {
          completion: {
            values: ['python', 'pytorch'],
            total: 2,
            hasMore: false,
          },
        }
      },
    }

    __setMcpClientsForTests([
      {
        type: 'connected',
        name: 'srv',
        client,
        capabilities: { completions: {} },
      } as any,
    ])

    const result = await captureMcpCli([
      'complete',
      '--server',
      'srv',
      '--prompt',
      'code_review',
      '--argument',
      'language',
      '--value',
      'py',
      '--context',
      '{"framework":"flask"}',
    ])

    expect(result.code).toBe(0)
    expect(result.stdout).toBe('python\npytorch\n')
    expect(result.stderr).toBe('')
    expect(requests).toEqual([
      {
        ref: { type: 'ref/prompt', name: 'code_review' },
        argument: { name: 'language', value: 'py' },
        context: { arguments: { framework: 'flask' } },
      },
    ])
  })

  test('rejects ambiguous prompt and resource references', async () => {
    const result = await captureMcpCli([
      'complete',
      '--server',
      'srv',
      '--prompt',
      'code_review',
      '--resource',
      'file:///{path}',
      '--argument',
      'language',
    ])

    expect(result.code).toBe(1)
    expect(result.stderr).toContain(
      'Error: Provide exactly one of --prompt or --resource',
    )
  })
})

describe('mcp-cli client-capabilities', () => {
  afterEach(() => {
    __setMcpClientsForTests(null)
    __resetMcpRootsForTests()
    __resetMcpSamplingForTests()
  })

  test('prints client capabilities as JSON', async () => {
    __setMcpRootsTrustOverrideForTests(true)

    const result = await captureMcpCli(['client-capabilities', '--json'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({
      roots: { enabled: true, listChanged: true },
      // Sampling is opt-in because an MCP server can initiate a billed model request.
      sampling: { enabled: false, context: false, tools: false },
      elicitation: { enabled: false, form: false, url: false },
      tasks: {
        enabled: false,
        list: false,
        cancel: false,
        samplingCreateMessage: false,
        elicitationCreate: false,
      },
    })
  })

  test('prints disabled client capabilities in text output', async () => {
    __setMcpRootsTrustOverrideForTests(false)
    __setMcpSamplingEnabledForTests(false)

    const result = await captureMcpCli(['client-capabilities'])

    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('roots: disabled')
    expect(result.stdout).toContain('sampling: disabled')
    expect(result.stdout).toContain('elicitation: disabled')
    expect(result.stdout).toContain('tasks: disabled')
  })

  test('prints sampling capabilities only after explicit opt-in', async () => {
    __setMcpRootsTrustOverrideForTests(true)
    __setMcpSamplingEnabledForTests(true)

    const result = await captureMcpCli(['client-capabilities', '--json'])

    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout).sampling).toEqual({
      enabled: true,
      context: false,
      tools: false,
    })
  })
})
