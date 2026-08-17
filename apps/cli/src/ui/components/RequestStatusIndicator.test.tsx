import { describe, expect, test } from 'bun:test'

import { __getRequestStatusLabelForTests } from './RequestStatusIndicator'

describe('RequestStatusIndicator', () => {
  test('shows a command-provided phase before the first response', () => {
    expect(
      __getRequestStatusLabelForTests(
        {
          kind: 'waiting',
          detail: 'Capabilities: preparing audit',
          updatedAt: 0,
        },
        0,
      ),
    ).toBe('Capabilities: preparing audit')
  })

  test('identifies an extended wait for the first model response', () => {
    expect(
      __getRequestStatusLabelForTests({ kind: 'waiting', updatedAt: 0 }, 15),
    ).toBe('Waiting for model response')
  })

  test('shows the active tool instead of hiding work in progress', () => {
    expect(
      __getRequestStatusLabelForTests(
        { kind: 'tool', detail: 'Bash', updatedAt: 0 },
        0,
      ),
    ).toBe('Working · Bash')
  })
})
