import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  parseAcceptanceCriteria,
  parseDatetimeLocal,
  parseEveryIntervalMs,
  SchedulesPage,
  toDatetimeLocalValue,
} from './Schedules'

describe('Schedules helpers', () => {
  test('parses supported interval strings only', () => {
    expect(parseEveryIntervalMs('30s')).toBe(30_000)
    expect(parseEveryIntervalMs('5m')).toBe(300_000)
    expect(parseEveryIntervalMs('1h')).toBe(3_600_000)
    expect(parseEveryIntervalMs('0s')).toBeNull()
    expect(parseEveryIntervalMs('5d')).toBeNull()
    expect(parseEveryIntervalMs('')).toBeNull()
  })

  test('normalizes one acceptance criterion per non-empty line', () => {
    expect(
      parseAcceptanceCriteria(' Focused tests pass \n\nBuild succeeds\r\n'),
    ).toEqual(['Focused tests pass', 'Build succeeds'])
  })

  test('round-trips a local schedule minute without inventing a timezone', () => {
    const local = new Date(2026, 7, 12, 14, 30, 0, 0)
    const value = toDatetimeLocalValue(local.getTime())

    expect(value).toBe('2026-08-12T14:30')
    expect(parseDatetimeLocal(value)).toBe(local.getTime())
    expect(parseDatetimeLocal('2026-08-12')).toBeNull()
    expect(parseDatetimeLocal('not-a-date')).toBeNull()
  })

  test('renders labeled keyboard-submit controls with explicit mode state', () => {
    const html = renderToStaticMarkup(
      createElement(SchedulesPage, {
        client: null,
        sessionId: '11111111-1111-4111-8111-111111111111',
        sessions: [
          {
            sessionId: '11111111-1111-4111-8111-111111111111',
            slug: 'release-session',
            customTitle: null,
            tag: null,
            summary: null,
            cwd: '/workspace',
            createdAt: null,
            modifiedAt: null,
          },
        ],
      }),
    )

    expect(html).toContain('<form')
    expect(html).toContain('for="goal-schedule-session"')
    expect(html).toContain('for="goal-objective"')
    expect(html).toContain('for="goal-interval"')
    expect(html).toContain('Describe the coding outcome')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('type="submit"')
    expect(html).toContain('aria-busy="false"')
  })
})
