import {
  MAX_GOAL_ACCEPTANCE_CRITERIA,
  MAX_GOAL_CONTINUATIONS,
  MAX_GOAL_CRITERION_CHARS,
  MAX_GOAL_REASON_CHARS,
} from './types'

/**
 * Internal validation/time helpers shared by GoalService and the daemon
 * control-plane module. Not part of the public goals API surface.
 */

export const DEFAULT_MAX_ITERATIONS = 8

export function cleanText(
  value: string,
  name: string,
  maxChars?: number,
): string {
  const text = String(value ?? '').trim()
  if (!text) throw new Error(`${name} cannot be empty.`)
  if (maxChars !== undefined && text.length > maxChars) {
    throw new Error(`${name} cannot exceed ${maxChars} characters.`)
  }
  return text
}

export function cleanCriteria(values: string[] | undefined): string[] {
  if (values === undefined) return []
  if (!Array.isArray(values)) {
    throw new Error('Goal acceptanceCriteria must be an array.')
  }
  const criteria = values.map((value, index) =>
    cleanText(
      value,
      `Goal acceptance criterion ${index + 1}`,
      MAX_GOAL_CRITERION_CHARS,
    ),
  )
  if (criteria.length > MAX_GOAL_ACCEPTANCE_CRITERIA) {
    throw new Error(
      `Goal acceptanceCriteria cannot contain more than ${MAX_GOAL_ACCEPTANCE_CRITERIA} items.`,
    )
  }
  return criteria
}

export function cleanOptionalReason(
  value: string | undefined,
): string | undefined {
  if (value === undefined || !value.trim()) return undefined
  return cleanText(value, 'Goal reason', MAX_GOAL_REASON_CHARS)
}

export function normaliseMaxIterations(value: number | undefined): number {
  const selected = value ?? DEFAULT_MAX_ITERATIONS
  if (
    !Number.isSafeInteger(selected) ||
    selected < 1 ||
    selected > MAX_GOAL_CONTINUATIONS
  ) {
    throw new Error(
      `Goal maxIterations must be an integer between 1 and ${MAX_GOAL_CONTINUATIONS}.`,
    )
  }
  return selected
}

/** Defer the first cadence to now + everyMs; do not fire immediately. */
export function nextDeferredIntervalAt(now: number, everyMs: number): number {
  const next = now + everyMs
  if (!Number.isSafeInteger(next)) {
    throw new Error('Interval schedule exceeds the supported timestamp range.')
  }
  return next
}
