import { describe, expect, test } from 'bun:test'
import {
  attachVerificationReceipt,
  classifyVerificationCommand,
  createVerificationReceipt,
  formatVerificationSystemMessage,
} from './receipt'

const fixedNow = new Date('2026-08-10T00:00:00.000Z')

function makeReceipt(
  overrides: {
    command?: string
    output?: Record<string, unknown>
    trusted?: boolean
  } = {},
) {
  return createVerificationReceipt({
    toolName: 'Bash',
    isTrustedExecutionTool: overrides.trusted ?? true,
    toolUseId: 'verify-1',
    input: { command: overrides.command ?? 'bun test ./packages/engine' },
    output: {
      stdout: '12 pass',
      stderr: '',
      interrupted: false,
      ...overrides.output,
    },
    now: fixedNow,
  })
}

describe('verification command classification', () => {
  test.each([
    ['bun test ./packages/engine', 'test'],
    ['CI=1 bun run typecheck', 'typecheck'],
    ['env CI=1 pnpm run lint', 'lint'],
    ['go build ./...', 'build'],
    ['cargo check --workspace', 'typecheck'],
    ['./gradlew check', 'check'],
    ['cd packages/engine && bun test', 'test'],
    ['cd "apps/web client" && pnpm run typecheck:ci', 'typecheck'],
    ['python -m pytest tests/unit', 'test'],
    ['uv run ruff check .', 'lint'],
    ['npx tsc --noEmit', 'typecheck'],
    ['make -C backend test', 'test'],
    ['git diff --check', 'check'],
    ['dotnet test', 'test'],
    ['swift build', 'build'],
  ] as const)('classifies a direct %s command as %s', (command, kind) => {
    expect(classifyVerificationCommand(command)).toBe(kind)
  })

  test.each([
    'echo bun test',
    'bun test && echo done',
    'bun test | tee test.log',
    'bun test; git status',
    'bun test\nmake deploy',
    'bun test $(whoami)',
    'cd packages/engine && bun test && make deploy',
    'cd $(pwd) && bun test',
    'bun test --help',
    'tsc --version',
  ])('rejects composite or merely quoted evidence: %s', command => {
    expect(classifyVerificationCommand(command)).toBeNull()
  })
})

describe('verification receipts', () => {
  test('records bounded success evidence without retaining command output', () => {
    const receipt = makeReceipt({
      command: 'bun test --reporter=dot ./packages/engine',
      output: { stdout: 'super-secret-test-output' },
    })
    if (!receipt) throw new Error('Expected a verification receipt')

    expect(receipt).toMatchObject({
      version: 1,
      kind: 'test',
      status: 'passed',
      toolUseId: 'verify-1',
      recordedAt: fixedNow.toISOString(),
    })
    expect(receipt.commandDigest).toMatch(/^[a-f0-9]{16}$/)
    expect(receipt.outputDigest).toMatch(/^[a-f0-9]{16}$/)
    expect(JSON.stringify(receipt)).not.toContain('super-secret')
    expect(JSON.stringify(receipt)).not.toContain('reporter=dot')
  })

  test.each([
    [{ stderr: 'Exit code 1' }, 'failed'],
    [{ interrupted: true }, 'interrupted'],
    [{ backgroundTaskId: 'task-1' }, 'started'],
    [{ stderr: 'Blocked: command requires approval' }, 'blocked'],
  ] as const)('records %s as %s', (output, status) => {
    const receipt = makeReceipt({ output })
    expect(receipt?.status).toBe(status)
  })

  test('requires the built-in execution trust boundary', () => {
    expect(makeReceipt({ trusted: false })).toBeNull()
  })

  test.each([
    ['completed', 0, 'passed'],
    ['failed', 1, 'failed'],
    ['killed', null, 'interrupted'],
    ['running', null, 'started'],
  ] as const)(
    'records a terminal background verification result: %s -> %s',
    (status, exitCode, expected) => {
      const receipt = createVerificationReceipt({
        toolName: 'TaskOutput',
        isTrustedExecutionTool: true,
        toolUseId: 'task-output-1',
        input: { task_id: 'bash-1' },
        output: {
          retrieval_status: status === 'running' ? 'not_ready' : 'success',
          task: {
            task_type: 'local_bash',
            status,
            command: 'bun test ./packages/engine',
            output: status === 'completed' ? '12 pass' : '',
            exitCode,
          },
        },
        now: fixedNow,
      })

      expect(receipt).toMatchObject({
        kind: 'test',
        status: expected,
        toolUseId: 'task-output-1',
      })
    },
  )

  test('attaches a receipt only to object-shaped tool results', () => {
    const receipt = makeReceipt()
    if (!receipt) throw new Error('Expected a verification receipt')

    const attached = attachVerificationReceipt(
      { stdout: 'ok' },
      receipt,
    ) as Record<string, unknown>
    expect(attached).toEqual({
      stdout: 'ok',
      verification: receipt,
    })
    expect(attachVerificationReceipt('ok', receipt)).toBe('ok')
    expect(attachVerificationReceipt(['ok'], receipt)).toEqual(['ok'])
  })

  test('system message limits the receipt scope and never includes raw output', () => {
    const receipt = makeReceipt({
      command: 'bun test --token super-secret',
      output: { stdout: 'super-secret-output' },
    })
    if (!receipt) throw new Error('Expected a verification receipt')

    const message = formatVerificationSystemMessage(receipt)
    expect(message).toContain('Verification receipt (engine generated)')
    expect(message).toContain('exact test command completed with status passed')
    expect(message).toContain('does not prove coverage of later edits')
    expect(message).not.toContain('super-secret')
  })
})
