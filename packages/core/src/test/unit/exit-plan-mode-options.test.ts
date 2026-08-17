import { describe, expect, test } from 'bun:test'
import { __getExitPlanModeOptionsForTests } from '#ui-ink/components/permissions/PlanModePermissionRequest/ExitPlanModePermissionRequest'

describe('ExitPlanMode options', () => {
  test('offers only Edit, Ask, and Plan transitions', () => {
    const options = __getExitPlanModeOptionsForTests({})

    expect(options.map(o => o.value)).toEqual([
      'yes-accept-edits',
      'yes-accept-edits-keep-context',
      'yes-cautious-keep-context',
      'no',
    ])
  })

  test('includes push-to-remote and swarm options when enabled', () => {
    const options = __getExitPlanModeOptionsForTests({
      pushToRemoteAvailable: true,
      swarmAvailable: true,
      teammateCount: 3,
    })

    expect(options.map(o => o.value)).toEqual([
      'yes-accept-edits',
      'yes-push-to-remote',
      'yes-launch-swarm-accept-edits',
      'yes-accept-edits-keep-context',
      'yes-cautious-keep-context',
      'no',
    ])
  })
})
