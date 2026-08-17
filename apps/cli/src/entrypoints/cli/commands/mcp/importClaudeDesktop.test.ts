import { describe, expect, test } from 'bun:test'

import { __scopeDisplayForImportForTests } from './importClaudeDesktop'

describe('mcp add-from-claude-desktop scope feedback', () => {
  test('labels the success message with the actual config scope', () => {
    expect(__scopeDisplayForImportForTests('project')).toBe('local')
    expect(__scopeDisplayForImportForTests('global')).toBe('user')
    expect(__scopeDisplayForImportForTests('mcpjson')).toBe('project')
    expect(__scopeDisplayForImportForTests('mcprc')).toBe('mcprc')
  })
})
