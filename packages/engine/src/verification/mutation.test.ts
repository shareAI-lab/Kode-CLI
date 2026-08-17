import { describe, expect, test } from 'bun:test'
import {
  canObserveWorkspaceMutationDuringCall,
  finalizeWorkspaceMutationReceipt,
} from './mutation'

describe('workspace mutation observation boundaries', () => {
  test('observes direct writes performed inside an ordinary tool call', () => {
    expect(
      canObserveWorkspaceMutationDuringCall({
        name: 'Edit',
        declaredScope: 'direct',
      }),
    ).toBe(true)
  })

  test('does not erase writes that completed before TaskOutput retrieval', () => {
    expect(
      canObserveWorkspaceMutationDuringCall({
        name: 'TaskOutput',
        declaredScope: 'direct',
      }),
    ).toBe(false)
    expect(
      finalizeWorkspaceMutationReceipt({
        toolUseId: 'task-output-1',
        declaredScope: 'direct',
        beforeFingerprint: null,
        afterFingerprint: null,
      }),
    ).toMatchObject({ scope: 'direct', basis: 'declared' })
  })
})
