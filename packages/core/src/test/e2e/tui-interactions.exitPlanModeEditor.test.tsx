import { afterEach, describe, expect, mock, test } from 'bun:test'
import React from 'react'

import { PermissionProvider } from '#ui-ink/contexts/PermissionContext'
import { KeypressProvider } from '#ui-ink/contexts/KeypressContext'
import { createInkHarnessManager, createInkTestHarness } from './inkTestHarness'

const harnessManager = createInkHarnessManager()

async function waitFor(
  harness: ReturnType<typeof createInkTestHarness>,
  condition: () => boolean,
  description: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await harness.wait(25)
  }

  throw new Error(
    `Timed out waiting for ${description}: ${harness.getOutput().slice(-4_000)}`,
  )
}

afterEach(async () => {
  await harnessManager.cleanup()
  mock.restore()
})

function mockPlanFile(): void {
  mock.module('#core/utils/planMode', () => ({
    getPlanConversationKey: () => 'conversation-1',
    getPlanFilePath: () => '/tmp/kode-plan.md',
    readPlanFile: () => ({ content: '# Test plan', exists: true }),
  }))
}

function createToolUseConfirm(): any {
  return {
    assistantMessage: { message: { id: 'message-1' } },
    tool: { name: 'ExitPlanMode' },
    input: {},
    toolUseContext: {
      messageId: 'message-1',
      abortController: new AbortController(),
      readFileTimestamps: {},
      options: { safeMode: false },
    },
    onAbort: () => {},
    onAllow: () => {},
    onReject: () => {},
  }
}

describe('TUI E2E regression (Ink render): ExitPlanMode editor', () => {
  test('starts one editor launch for rapid Ctrl+G and ignores completion after unmount', async () => {
    let launches = 0
    let resolveEditor:
      ((value: { ok: true; editorLabel: string }) => void) | null = null
    const finishEditor = (): void => {
      resolveEditor?.({ ok: true, editorLabel: 'test-editor' })
    }

    mockPlanFile()
    mock.module('#cli-utils/externalEditor', () => ({
      getExternalEditorLabel: () => 'test-editor',
      launchExternalEditor: async () => ({ text: null }),
      launchExternalEditorForFilePath: () => {
        launches += 1
        return new Promise<{ ok: true; editorLabel: string }>(resolve => {
          resolveEditor = resolve
        })
      },
    }))

    const { ExitPlanModePermissionRequest } =
      await import('#ui-ink/components/permissions/PlanModePermissionRequest/ExitPlanModePermissionRequest')
    const h = createInkTestHarness(
      <KeypressProvider>
        <PermissionProvider
          conversationKey="conversation-1"
          isBypassPermissionsModeAvailable
        >
          <ExitPlanModePermissionRequest
            toolUseConfirm={createToolUseConfirm()}
            onDone={() => {}}
            verbose={false}
          />
        </PermissionProvider>
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await waitFor(
      h,
      () => h.getOutput().includes('Ready to code?'),
      'plan view',
    )
    h.stdin.write('\u0007')
    h.stdin.write('\u0007')
    await waitFor(
      h,
      () => h.getOutput().includes('Opening external editor…'),
      'opening editor status',
    )

    expect(launches).toBe(1)

    h.unmount()
    finishEditor()
    await h.wait(25)
  })

  test('reports editor launcher failures and allows Ctrl+G retry', async () => {
    let launches = 0

    mockPlanFile()
    mock.module('#cli-utils/externalEditor', () => ({
      getExternalEditorLabel: () => 'test-editor',
      launchExternalEditor: async () => ({ text: null }),
      launchExternalEditorForFilePath: async () => {
        launches += 1
        throw new Error('temporary editor failure')
      },
    }))

    const { ExitPlanModePermissionRequest } =
      await import('#ui-ink/components/permissions/PlanModePermissionRequest/ExitPlanModePermissionRequest')
    const h = createInkTestHarness(
      <KeypressProvider>
        <PermissionProvider
          conversationKey="conversation-1"
          isBypassPermissionsModeAvailable
        >
          <ExitPlanModePermissionRequest
            toolUseConfirm={createToolUseConfirm()}
            onDone={() => {}}
            verbose={false}
          />
        </PermissionProvider>
      </KeypressProvider>,
    )
    harnessManager.track(h)

    await waitFor(
      h,
      () => h.getOutput().includes('Ready to code?'),
      'plan view',
    )
    h.stdin.write('\u0007')
    await waitFor(
      h,
      () =>
        h
          .getOutput()
          .includes(
            'Unable to open the external editor. Check $EDITOR and try again.',
          ),
      'editor failure status',
    )

    expect(launches).toBe(1)

    h.stdin.write('\u0007')
    await waitFor(h, () => launches === 2, 'retry launcher call')
    expect(launches).toBe(2)
  })
})
