import { describe, expect, it } from 'bun:test'
import {
  __groupAssistantContentForTests,
  __normalizeAggregatedToolNameForTests,
} from './Message'

function toolUse(id: string, name: string, query: string) {
  return { type: 'tool_use', id, name, input: { query } }
}

describe('assistant tool-use grouping', () => {
  it('groups consecutive web searches into one block', () => {
    const content = [
      { type: 'text', text: 'searching...' },
      toolUse('s1', 'web_search', '今天天气 2025'),
      toolUse('s2', 'web_search', 'current weather today'),
      toolUse('s3', 'web_search', '上海 天气'),
      { type: 'text', text: 'done' },
    ]

    const grouped = __groupAssistantContentForTests(content)
    expect(grouped).toHaveLength(3)
    expect(grouped[1]).toMatchObject({
      type: 'group',
      name: 'web_search',
    })
    expect((grouped[1] as { blocks: unknown[] }).blocks).toHaveLength(3)
    expect(grouped[0]?.type).toBe('single')
    expect(grouped[2]?.type).toBe('single')
  })

  it('does not merge groups across different tools or gaps', () => {
    const content = [
      toolUse('s1', 'web_search', 'a'),
      toolUse('f1', 'Fetch', 'https://x.com'),
      toolUse('s2', 'web_search', 'b'),
    ]

    const grouped = __groupAssistantContentForTests(content)
    expect(grouped).toHaveLength(3)
    for (const item of grouped) {
      expect(item.type).toBe('group')
    }
  })

  it('keeps non-aggregatable tools as single blocks', () => {
    const content = [
      toolUse('b1', 'Bash', 'ls -la'),
      toolUse('b2', 'Bash', 'git status'),
    ]

    const grouped = __groupAssistantContentForTests(content)
    expect(grouped).toHaveLength(2)
    expect(grouped[0]?.type).toBe('single')
  })

  it('normalizes search tool names for display', () => {
    expect(__normalizeAggregatedToolNameForTests('web_search')).toBe('Search')
    expect(__normalizeAggregatedToolNameForTests('WebSearch')).toBe('Search')
    expect(__normalizeAggregatedToolNameForTests('Fetch')).toBe('Fetch')
  })
})
