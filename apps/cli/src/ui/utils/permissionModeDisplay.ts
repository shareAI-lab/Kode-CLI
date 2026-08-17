import type { PermissionMode } from '#core/types/PermissionMode'
import { normalizePermissionMode } from '#core/types/PermissionMode'

export function getPermissionModeStatusLabel(mode: PermissionMode): string {
  switch (normalizePermissionMode(mode)) {
    case 'plan':
      return 'Plan first'
    case 'acceptEdits':
      return 'Edit'
    case 'cautious':
      return 'Ask before tools'
  }
}

/**
 * A short, unambiguous label for narrow, always-visible UI such as the
 * prompt status row. Keep the longer labels above for screens that have room
 * to explain the policy in full.
 */
export function getPermissionModeCompactLabel(mode: PermissionMode): string {
  switch (normalizePermissionMode(mode)) {
    case 'plan':
      return 'Plan'
    case 'acceptEdits':
      return 'Edit'
    case 'cautious':
      return 'Ask'
  }
}

export function getPermissionModeDetail(mode: PermissionMode): string {
  switch (normalizePermissionMode(mode)) {
    case 'plan':
      return 'review plans before implementation'
    case 'acceptEdits':
      return 'run workspace operations automatically'
    case 'cautious':
      return 'ask before tool use'
  }
}
