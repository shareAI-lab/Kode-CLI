import { GoalService, type Goal } from '#core/goals'

const INTERVAL_FACTORS: Record<'s' | 'm' | 'h', number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
}

const EVERY_OPTION_PATTERN = /(?:^|\s)--every(?:\s+|=)(\d+[smh])(?=\s|$)/i
const EVERY_FLAG_PATTERN = /(?:^|\s)--every(?:\s|=|$)/i

export function parseEveryInterval(value: string): number | null {
  const match = value.trim().match(/^(\d+)([smh])$/i)
  if (!match?.[1] || !match[2]) return null
  const count = Number.parseInt(match[1], 10)
  const unit = match[2].toLowerCase() as keyof typeof INTERVAL_FACTORS
  if (!Number.isFinite(count) || count <= 0) return null
  const milliseconds = count * INTERVAL_FACTORS[unit]
  return Number.isSafeInteger(milliseconds) ? milliseconds : null
}

export function parseGoalScheduleArgs(
  raw: string,
  options: { requireEvery?: boolean } = {},
): { objective: string; everyMs?: number } | { error: string } {
  const requireEvery = options.requireEvery === true
  const match = raw.match(EVERY_OPTION_PATTERN)
  if (!match?.[1]) {
    if (EVERY_FLAG_PATTERN.test(raw)) {
      return { error: 'Missing --every interval (for example: --every 5m).' }
    }
    if (requireEvery) {
      return { error: 'Missing --every interval (for example: --every 5m).' }
    }
    return { objective: raw.trim() }
  }

  const everyMs = parseEveryInterval(match[1])
  if (!everyMs) {
    return {
      error:
        'Invalid --every interval. Use a positive value such as 30s, 5m, or 1h.',
    }
  }

  const objective = raw.replace(match[0], ' ').trim()
  if (EVERY_FLAG_PATTERN.test(objective)) {
    return { error: 'Use only one --every interval per goal.' }
  }
  if (!objective && requireEvery) {
    return { error: 'A loop objective is required.' }
  }
  return { objective, everyMs }
}

export function parseLoopCreateArgs(
  raw: string,
): { objective: string; everyMs: number } | { error: string } {
  const parsed = parseGoalScheduleArgs(raw, { requireEvery: true })
  if ('error' in parsed) return parsed
  if (!parsed.everyMs) {
    return { error: 'Missing --every interval (for example: --every 5m).' }
  }
  if (!parsed.objective) return { error: 'A loop objective is required.' }
  return { objective: parsed.objective, everyMs: parsed.everyMs }
}

export function createIntervalGoal(args: {
  cwd: string
  sessionId: string
  objective: string
  everyMs: number
  maxIterations?: number
  now?: number
}): Goal {
  const now = args.now ?? Date.now()
  return new GoalService().createGoal({
    cwd: args.cwd,
    sessionId: args.sessionId,
    objective: args.objective,
    schedule: {
      kind: 'interval',
      prompt: args.objective,
      everyMs: args.everyMs,
      // A recurring goal begins on its next cadence. Use `/goal <objective>`
      // for a turn that should start as soon as the session is idle.
      anchorAt: now + args.everyMs,
    },
    ...(args.maxIterations
      ? { loop: { maxIterations: args.maxIterations } }
      : {}),
  })
}
