import { afterEach, describe, expect, test } from 'bun:test'

import {
  formatMcpClientCapabilitySummary,
  getMcpClientCapabilitySummary,
  summarizeMcpClientCapabilities,
} from '#core/mcp/client'
import {
  __resetMcpRootsForTests,
  __setMcpRootsTrustOverrideForTests,
} from '#core/mcp/client/roots'
import {
  __resetMcpSamplingForTests,
  __setMcpSamplingEnabledForTests,
} from '#core/mcp/client/sampling'

describe('MCP client capability summary', () => {
  afterEach(() => {
    __resetMcpRootsForTests()
    __resetMcpSamplingForTests()
  })

  test('summarizes trusted root capability exposure with sampling enabled', () => {
    __setMcpRootsTrustOverrideForTests(true)
    __setMcpSamplingEnabledForTests(true)

    expect(getMcpClientCapabilitySummary()).toEqual({
      roots: { enabled: true, listChanged: true },
      sampling: { enabled: true, context: false, tools: false },
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

  test('summarizes capabilities when sampling is disabled', () => {
    __setMcpRootsTrustOverrideForTests(true)
    __setMcpSamplingEnabledForTests(false)

    expect(getMcpClientCapabilitySummary()).toEqual({
      roots: { enabled: true, listChanged: true },
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

  test('formats enabled and disabled client capabilities consistently', () => {
    const summary = summarizeMcpClientCapabilities({
      roots: { listChanged: false },
      sampling: { context: {}, tools: {} },
      elicitation: { form: {}, url: {} },
      tasks: {
        list: {},
        cancel: {},
        requests: {
          sampling: { createMessage: {} },
          elicitation: { create: {} },
        },
      },
    })

    expect(formatMcpClientCapabilitySummary(summary)).toEqual([
      'roots: enabled',
      'sampling: enabled (context, tools)',
      'elicitation: enabled (form, url)',
      'tasks: enabled (list, cancel, sampling.createMessage, elicitation.create)',
    ])
  })

  test('formats disabled client capabilities consistently', () => {
    const summary = summarizeMcpClientCapabilities({})

    expect(formatMcpClientCapabilitySummary(summary)).toEqual([
      'roots: disabled',
      'sampling: disabled',
      'elicitation: disabled',
      'tasks: disabled',
    ])
  })
})
