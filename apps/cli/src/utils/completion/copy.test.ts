import { describe, expect, test } from 'bun:test'
import { emptyDirectoryCompletionMessage } from './copy'

describe('emptyDirectoryCompletionMessage', () => {
  test('names the directory the user just opened', () => {
    expect(emptyDirectoryCompletionMessage('docs/')).toBe('No files in docs/')
  })

  test('falls back when the path is blank', () => {
    expect(emptyDirectoryCompletionMessage('   ')).toBe(
      'No files in this directory',
    )
  })
})
