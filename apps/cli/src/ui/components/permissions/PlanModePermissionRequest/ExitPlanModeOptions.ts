export type ExitPlanModeOptionValue =
  | 'yes-push-to-remote'
  | 'yes-accept-edits'
  | 'yes-accept-edits-keep-context'
  | 'yes-cautious-keep-context'
  | 'yes-launch-swarm-accept-edits'
  | 'no'

export type ExitPlanModeOption =
  | {
      type?: 'option'
      label: string
      value: Exclude<ExitPlanModeOptionValue, 'no'>
    }
  | {
      type: 'input'
      label: string
      value: 'no'
      placeholder: string
    }

export function getExitPlanModeOptions(args: {
  pushToRemoteAvailable?: boolean
  swarmAvailable?: boolean
  teammateCount?: number
  /**
   * Label of the actual mode-cycle shortcut (e.g. "shift+tab" or "F9" on
   * older Windows runtimes). Keeps the option copy truthful per platform.
   */
  quickSelectLabel?: string
}): ExitPlanModeOption[] {
  const options: ExitPlanModeOption[] = []

  options.push({
    label: args.quickSelectLabel
      ? `Yes, clear context and enter Edit mode (${args.quickSelectLabel})`
      : 'Yes, clear context and enter Edit mode',
    value: 'yes-accept-edits',
  })

  if (args.pushToRemoteAvailable) {
    options.push({
      label: 'Yes, push to remote',
      value: 'yes-push-to-remote',
    })
  }

  if (args.swarmAvailable) {
    const count = Math.max(1, Math.min(10, args.teammateCount ?? 3))
    options.push({
      label: `Yes, and launch swarm (${count} teammates [tab])`,
      value: 'yes-launch-swarm-accept-edits',
    })
  }

  options.push({
    label: 'Yes, continue in Edit mode',
    value: 'yes-accept-edits-keep-context',
  })

  options.push({
    label: 'Yes, continue in Ask mode',
    value: 'yes-cautious-keep-context',
  })

  options.push({
    type: 'input',
    label: 'No, keep planning',
    value: 'no',
    placeholder: 'Type here to tell Kode what to change',
  })

  return options
}

export function __getExitPlanModeOptionsForTests(args: {
  pushToRemoteAvailable?: boolean
  swarmAvailable?: boolean
  teammateCount?: number
  quickSelectLabel?: string
}): ExitPlanModeOption[] {
  return getExitPlanModeOptions(args)
}
