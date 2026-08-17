import { describe, expect, test } from 'bun:test'
import type { Message, UserMessage } from '../pipeline/types'
import {
  collectGoalVerificationEvidence,
  getTurnVerificationState,
} from './evidence'

const receipt = {
  version: 1 as const,
  kind: 'test' as const,
  status: 'passed' as const,
  toolUseId: 'verify-1',
  commandDigest: 'a'.repeat(16),
  outputDigest: 'b'.repeat(16),
  recordedAt: '2026-08-10T00:00:00.000Z',
}

function toolUse(
  tools: Array<{ id: string; name: string; input: Record<string, unknown> }>,
): Message {
  return {
    type: 'assistant',
    uuid: crypto.randomUUID() as never,
    costUSD: 0,
    durationMs: 0,
    message: {
      id: crypto.randomUUID(),
      model: 'test',
      role: 'assistant',
      type: 'message',
      content: tools.map(tool => ({ type: 'tool_use', ...tool })),
      usage: {} as never,
    },
  }
}

function toolResult(data: unknown, toolUseId = receipt.toolUseId): UserMessage {
  return {
    type: 'user',
    uuid: crypto.randomUUID() as never,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: 'tool output',
        },
      ],
    },
    toolUseResult: { data, resultForAssistant: 'tool output' },
  }
}

function toolResultWithMutation(
  data: unknown,
  toolUseId: string,
  scope: 'none' | 'direct' | 'delegated',
): Message {
  const message = toolResult(data, toolUseId)
  if (!message.toolUseResult) throw new Error('Expected tool result metadata')
  message.toolUseResult.metadata = {
    workspaceMutation: {
      version: 1,
      toolUseId,
      scope,
      basis: scope === 'delegated' ? 'delegated' : 'observed',
    },
  }
  return message
}

function rejectedToolResult(toolUseId: string): Message {
  return {
    type: 'user',
    uuid: crypto.randomUUID() as never,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: 'Permission denied',
          is_error: true,
        },
      ],
    },
  }
}

function userPrompt(text: string): Message {
  return {
    type: 'user',
    uuid: crypto.randomUUID() as never,
    message: { role: 'user', content: text },
  }
}

describe('goal verification evidence', () => {
  test('keeps a Bash receipt that follows an earlier source write', () => {
    const evidence = collectGoalVerificationEvidence([
      toolUse([
        {
          id: 'edit-1',
          name: 'Edit',
          input: { file_path: '/workspace/a.ts' },
        },
      ]),
      toolResult({}, 'edit-1'),
      toolUse([
        {
          id: receipt.toolUseId,
          name: 'Bash',
          input: { command: 'bun test ./packages/engine' },
        },
      ]),
      toolResult({ verification: receipt }),
    ])

    expect(evidence).toEqual([receipt])
  })

  test('accepts a trusted background verification receipt from TaskOutput', () => {
    const taskOutputReceipt = {
      ...receipt,
      toolUseId: 'task-output-1',
    }
    const messages: Message[] = [
      userPrompt('Implement and test the change in the background.'),
      toolUse([{ id: 'edit-1', name: 'Edit', input: { file_path: 'a.ts' } }]),
      toolResultWithMutation({}, 'edit-1', 'direct'),
      toolUse([
        {
          id: 'task-output-1',
          name: 'TaskOutput',
          input: { task_id: 'background-test-1', block: true },
        },
      ]),
      toolResultWithMutation(
        { verification: taskOutputReceipt },
        'task-output-1',
        'none',
      ),
    ]

    expect(getTurnVerificationState(messages)).toMatchObject({
      hasMutation: true,
      hasTerminalEvidence: true,
      evidence: [taskOutputReceipt],
    })
  })

  test('drops a receipt after a later file write or non-read-only Bash command', () => {
    const verified = [
      toolUse([
        {
          id: receipt.toolUseId,
          name: 'Bash',
          input: { command: 'bun test ./packages/engine' },
        },
      ]),
      toolResult({ verification: receipt }),
    ]

    expect(
      collectGoalVerificationEvidence([
        ...verified,
        toolUse([
          {
            id: 'write-1',
            name: 'Write',
            input: { file_path: '/workspace/a.ts', content: 'changed' },
          },
        ]),
      ]),
    ).toEqual([])
    expect(
      collectGoalVerificationEvidence([
        ...verified,
        toolUse([
          {
            id: 'bash-write-1',
            name: 'Bash',
            input: { command: 'touch /workspace/a.ts' },
          },
        ]),
      ]),
    ).toEqual([])
  })

  test('keeps a receipt after a centrally-classified read-only Bash command', () => {
    const evidence = collectGoalVerificationEvidence([
      toolUse([
        {
          id: receipt.toolUseId,
          name: 'Bash',
          input: { command: 'bun test ./packages/engine' },
        },
      ]),
      toolResult({ verification: receipt }),
      toolUse([
        {
          id: 'status-1',
          name: 'Bash',
          input: { command: 'git status --short' },
        },
      ]),
    ])

    expect(evidence).toEqual([receipt])
  })

  test('drops a receipt issued beside a concurrent write', () => {
    const evidence = collectGoalVerificationEvidence([
      toolUse([
        {
          id: 'edit-1',
          name: 'Edit',
          input: { file_path: '/workspace/a.ts' },
        },
        {
          id: receipt.toolUseId,
          name: 'Bash',
          input: { command: 'bun test ./packages/engine' },
        },
      ]),
      toolResult({ verification: receipt }),
    ])

    expect(evidence).toEqual([])
  })

  test('drops a receipt after an unknown tool because it may write the workspace', () => {
    const evidence = collectGoalVerificationEvidence([
      toolUse([
        {
          id: receipt.toolUseId,
          name: 'Bash',
          input: { command: 'bun test ./packages/engine' },
        },
      ]),
      toolResult({ verification: receipt }),
      toolUse([
        {
          id: 'mcp-1',
          name: 'mcp',
          input: { server: 'workspace-plugin', tool: 'apply_changes' },
        },
      ]),
    ])

    expect(evidence).toEqual([])
  })

  test('does not mistake delegated code exploration for a workspace write', () => {
    const state = getTurnVerificationState([
      userPrompt('Read the loop implementation and explain it.'),
      toolUse([
        {
          id: 'task-1',
          name: 'Task',
          input: { subagent_type: 'Explore', prompt: 'Read code' },
        },
      ]),
      toolResultWithMutation({}, 'task-1', 'delegated'),
      toolUse([
        {
          id: 'read-1',
          name: 'Read',
          input: { file_path: '/workspace/a.ts' },
        },
      ]),
      toolResult({}, 'read-1'),
    ])

    expect(state).toMatchObject({
      hasMutation: false,
      hasTerminalEvidence: false,
    })
  })

  test('uses engine mutation receipts instead of guessing from a tool name', () => {
    const observedReadOnly = getTurnVerificationState([
      userPrompt('Inspect with a workspace plugin.'),
      toolUse([
        {
          id: 'mcp-read-1',
          name: 'mcp',
          input: { server: 'workspace-plugin', tool: 'inspect' },
        },
      ]),
      toolResultWithMutation({}, 'mcp-read-1', 'none'),
    ])
    const observedWrite = getTurnVerificationState([
      userPrompt('Run a custom workspace operation.'),
      toolUse([
        {
          id: 'read-looks-safe',
          name: 'Read',
          input: { file_path: '/workspace/a.ts' },
        },
      ]),
      toolResultWithMutation({}, 'read-looks-safe', 'direct'),
    ])

    expect(observedReadOnly.hasMutation).toBe(false)
    expect(observedWrite.hasMutation).toBe(true)
  })

  test('does not require verification for a write tool rejected before execution', () => {
    const state = getTurnVerificationState([
      userPrompt('Edit a.ts'),
      toolUse([{ id: 'edit-1', name: 'Edit', input: { file_path: 'a.ts' } }]),
      rejectedToolResult('edit-1'),
    ])

    expect(state.hasMutation).toBe(false)
  })

  test('keeps interrupted direct tools fail-closed when no result exists', () => {
    const state = getTurnVerificationState([
      userPrompt('Edit a.ts'),
      toolUse([{ id: 'edit-1', name: 'Edit', input: { file_path: 'a.ts' } }]),
    ])

    expect(state.hasMutation).toBe(true)
  })

  test('rejects unmatched, malformed, and non-Bash receipt-shaped data', () => {
    expect(
      collectGoalVerificationEvidence([
        toolUse([
          {
            id: 'read-1',
            name: 'Read',
            input: { file_path: '/workspace/a.ts' },
          },
        ]),
        toolResult({ verification: receipt }, 'read-1'),
      ]),
    ).toEqual([])
    expect(
      collectGoalVerificationEvidence([
        toolUse([
          {
            id: receipt.toolUseId,
            name: 'Bash',
            input: { command: 'bun test ./packages/engine' },
          },
        ]),
        toolResult({
          verification: { ...receipt, commandDigest: 'not-a-digest' },
        }),
      ]),
    ).toEqual([])
  })

  test('scopes the completion gate to the active human turn', () => {
    const messages: Message[] = [
      userPrompt('Edit a.ts'),
      toolUse([{ id: 'edit-1', name: 'Edit', input: { file_path: 'a.ts' } }]),
      toolResult({}, 'edit-1'),
      userPrompt('Now explain the architecture without changing files.'),
    ]

    expect(getTurnVerificationState(messages)).toMatchObject({
      turnStartMessageIndex: 3,
      hasMutation: false,
      hasTerminalEvidence: false,
      evidence: [],
    })
  })

  test('treats an image-only human message as a new turn boundary', () => {
    const messages: Message[] = [
      userPrompt('Edit a.ts'),
      toolUse([{ id: 'edit-1', name: 'Edit', input: { file_path: 'a.ts' } }]),
      toolResult({}, 'edit-1'),
      userPrompt([
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'AA==' },
        },
      ] as never),
    ]

    expect(getTurnVerificationState(messages).hasMutation).toBe(false)
  })

  test('requires terminal evidence after the latest mutation in the active turn', () => {
    const base: Message[] = [
      userPrompt('Implement the change.'),
      toolUse([{ id: 'edit-1', name: 'Edit', input: { file_path: 'a.ts' } }]),
      toolResult({}, 'edit-1'),
    ]

    expect(getTurnVerificationState(base)).toMatchObject({
      turnStartMessageIndex: 0,
      hasMutation: true,
      hasTerminalEvidence: false,
      evidence: [],
    })

    const withStartedVerification = [
      ...base,
      toolUse([
        {
          id: receipt.toolUseId,
          name: 'Bash',
          input: { command: 'bun test', run_in_background: true },
        },
      ]),
      toolResult({
        verification: { ...receipt, status: 'started' as const },
      }),
    ]
    expect(getTurnVerificationState(withStartedVerification)).toMatchObject({
      hasMutation: true,
      hasTerminalEvidence: false,
    })

    const withPassedVerification = [
      ...base,
      toolUse([
        {
          id: receipt.toolUseId,
          name: 'Bash',
          input: { command: 'bun test' },
        },
      ]),
      toolResult({ verification: receipt }),
    ]
    expect(getTurnVerificationState(withPassedVerification)).toMatchObject({
      hasMutation: true,
      hasTerminalEvidence: true,
      evidence: [receipt],
    })
  })

  test('does not let an engine recovery prompt hide the original mutation', () => {
    const state = getTurnVerificationState([
      userPrompt('Implement the change.'),
      toolUse([{ id: 'edit-1', name: 'Edit', input: { file_path: 'a.ts' } }]),
      toolResult({}, 'edit-1'),
      userPrompt(
        '<verification-recovery>Run an applicable check.</verification-recovery>',
      ),
    ])

    expect(state.turnStartMessageIndex).toBe(0)
    expect(state.hasMutation).toBe(true)
  })
})
