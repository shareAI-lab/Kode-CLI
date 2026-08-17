import { describe, expect, test } from 'bun:test'

import { __buildPermissionRequestDetailsLinesForTests } from './PermissionRequestDetails'

describe('PermissionRequestDetails helpers', () => {
  test('builds header + reason + path', () => {
    const lines = __buildPermissionRequestDetailsLinesForTests({
      toolUseContext: {
        agentId: 'main',
        options: { toolPermissionContext: { mode: 'plan' } },
      },
      decisionReason: 'No allow rule matched (outside working directories)',
      blockedPath: '/tmp/example.txt',
    } as any)

    expect(lines).toEqual([
      'Agent: main · Mode: Plan first',
      'Reason: No allow rule matched (outside working directories)',
      'Path: /tmp/example.txt',
    ])
  })

  test('uses the readable permission policy name', () => {
    const lines = __buildPermissionRequestDetailsLinesForTests({
      toolUseContext: {
        agentId: 'main',
        options: { toolPermissionContext: { mode: 'acceptEdits' } },
      },
    } as any)

    expect(lines).toEqual(['Agent: main · Mode: Edit'])
  })

  test('returns empty list when nothing is available', () => {
    const lines = __buildPermissionRequestDetailsLinesForTests({
      toolUseContext: { agentId: '' },
    } as any)
    expect(lines).toEqual([])
  })
})
