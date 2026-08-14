export type ExitPlanModeOptionValue =
  | 'yes-push-to-remote'
  | 'yes-bypass-permissions'
  | 'yes-accept-edits'
  | 'yes-accept-edits-keep-context'
  | 'yes-default-keep-context'
  | 'yes-launch-swarm-accept-edits'
  | 'yes-launch-swarm-bypass'
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
  bypassAvailable: boolean
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

  options.push(
    args.bypassAvailable
      ? {
          label: 'Yes, clear context and bypass permissions',
          value: 'yes-bypass-permissions',
        }
      : {
          label: args.quickSelectLabel
            ? `Yes, clear context and auto-accept edits (${args.quickSelectLabel})`
            : 'Yes, clear context and auto-accept edits',
          value: 'yes-accept-edits',
        },
  )

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

    if (args.bypassAvailable) {
      options.push({
        label: `Yes, and launch swarm (bypass, ${count} teammates [tab])`,
        value: 'yes-launch-swarm-bypass',
      })
    }
  }

  options.push({
    label: args.bypassAvailable
      ? 'Yes, and bypass permissions'
      : 'Yes, auto-accept edits',
    value: 'yes-accept-edits-keep-context',
  })

  options.push({
    label: 'Yes, manually approve edits',
    value: 'yes-default-keep-context',
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
  bypassAvailable: boolean
  pushToRemoteAvailable?: boolean
  swarmAvailable?: boolean
  teammateCount?: number
  quickSelectLabel?: string
}): ExitPlanModeOption[] {
  return getExitPlanModeOptions(args)
}
