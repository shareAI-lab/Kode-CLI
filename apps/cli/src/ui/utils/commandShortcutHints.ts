export type CommandShortcutHint = {
  trigger: string
  effect: string
}

export type CommandShortcutHints = {
  commands: readonly CommandShortcutHint[]
  shortcuts: readonly CommandShortcutHint[]
}

export function getShortcutModifierLabel(
  platform = process.platform,
): 'Alt' | 'Option' {
  return platform === 'darwin' ? 'Option' : 'Alt'
}

export function getCommandShortcutHints(
  platform = process.platform,
): CommandShortcutHints {
  const modifier = getShortcutModifierLabel(platform)

  return {
    commands: [
      { trigger: '/config', effect: 'setup models and tools' },
      { trigger: '/help', effect: 'open help' },
      { trigger: '/model', effect: 'manage models' },
      { trigger: '/init', effect: 'create AGENTS.md' },
    ],
    shortcuts: [
      { trigger: `${modifier}+M`, effect: 'switch model' },
      { trigger: `${modifier}+G`, effect: 'open external editor' },
    ],
  }
}
