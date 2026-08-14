import { afterEach, describe, expect, test } from 'bun:test'

import { EXPERIMENTAL_MCP_SAMPLING_ENV } from '#config/experimental'

import {
  __resetMcpSamplingForTests,
  __setMcpSamplingEnabledForTests,
  registerMcpSamplingHandler,
} from './sampling'

const originalSamplingFlag = process.env[EXPERIMENTAL_MCP_SAMPLING_ENV]

afterEach(() => {
  __resetMcpSamplingForTests()
  if (originalSamplingFlag === undefined) {
    delete process.env[EXPERIMENTAL_MCP_SAMPLING_ENV]
  } else {
    process.env[EXPERIMENTAL_MCP_SAMPLING_ENV] = originalSamplingFlag
  }
})

describe('MCP sampling rollout gate', () => {
  test('does not register a model-invoking handler by default', () => {
    delete process.env[EXPERIMENTAL_MCP_SAMPLING_ENV]
    const registered: unknown[] = []
    const client = {
      setRequestHandler(schema: unknown) {
        registered.push(schema)
      },
    }

    registerMcpSamplingHandler(client as never)

    expect(registered).toEqual([])
  })

  test('registers the handler only after explicit experimental opt-in', () => {
    __setMcpSamplingEnabledForTests(true)
    const registered: unknown[] = []
    const client = {
      setRequestHandler(schema: unknown) {
        registered.push(schema)
      },
    }

    registerMcpSamplingHandler(client as never)

    expect(registered).toHaveLength(1)
  })
})
