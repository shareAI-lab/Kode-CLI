import {
  normalizePermissionMode,
  type PermissionMode,
} from '#core/types/PermissionMode'

import type * as Protocol from '../protocol'

const MODE_SET: ReadonlySet<PermissionMode> = new Set([
  'acceptEdits',
  'cautious',
  'plan',
])

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && MODE_SET.has(value as PermissionMode)
}

export function coercePermissionMode(value: unknown): PermissionMode {
  return typeof value === 'string' ? normalizePermissionMode(value) : 'cautious'
}

export function getModeState(
  currentModeId: unknown,
): Protocol.SessionModeState {
  const availableModes: Protocol.SessionMode[] = [
    {
      id: 'acceptEdits',
      name: 'Edit',
      description: 'Run normal workspace operations automatically',
    },
    {
      id: 'plan',
      name: 'Plan',
      description: 'Read-only planning mode',
    },
    {
      id: 'cautious',
      name: 'Ask',
      description: 'Ask before operations',
    },
  ]

  const current = coercePermissionMode(currentModeId)
  return { currentModeId: current, availableModes }
}
