import { describe, expect, test } from 'bun:test'
import { BashTool } from '#tools/tools/system/BashTool/BashTool'
import { TaskOutputTool } from '#tools/tools/system/TaskOutputTool/TaskOutputTool'
import { TaskStopTool } from '#tools/tools/system/TaskStopTool/TaskStopTool'
import { TodoWriteTool } from '#tools/tools/interaction/TodoWriteTool/TodoWriteTool'
import { WebFetchTool } from '#tools/tools/network/WebFetchTool/WebFetchTool'
import {
  getGitCommitMessageFormattingPrompt,
  getPullRequestBodyFormattingPrompt,
} from '#tools/tools/system/BashTool/prompt'

describe('Tool prompt/description/schema parity', () => {
  test('BashTool description uses input.description or falls back', async () => {
    expect(
      await BashTool.description?.({
        command: 'ls',
        description: 'List files',
      }),
    ).toBe('List files')

    expect(await BashTool.description?.({ command: 'ls' })).toBe(
      'Run shell command',
    )
  })

  test('BashTool prompt contains reference sections', async () => {
    const prompt = await BashTool.prompt()
    expect(prompt).toContain(
      'Executes a given bash command in a persistent shell session with optional timeout, ensuring proper handling and security measures.',
    )
    expect(prompt).toContain(
      'IMPORTANT: This tool is for terminal operations like git, npm, docker, etc. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools for this instead.',
    )
    expect(prompt).toContain('# Committing changes with git')
    expect(prompt).toContain('# Creating pull requests')
    expect(prompt).toContain('Git Safety Protocol:')
  })

  test('BashTool git examples use file-based multiline input on Windows', () => {
    const commitPrompt = getGitCommitMessageFormattingPrompt(
      'Generated with Kode',
      'win32',
    )
    const prPrompt = getPullRequestBodyFormattingPrompt(
      'Generated with Kode',
      'win32',
    )

    expect(commitPrompt).toContain('git commit --file')
    expect(commitPrompt).toContain('Set-Content -LiteralPath $msg')
    expect(commitPrompt).not.toContain("cat <<'EOF'")
    expect(prPrompt).toContain(
      'gh pr create --title "the pr title" --body-file',
    )
    expect(prPrompt).toContain('Set-Content -LiteralPath $body')
    expect(prPrompt).not.toContain("cat <<'EOF'")
  })

  test('BashTool git examples keep heredocs on POSIX platforms', () => {
    const commitPrompt = getGitCommitMessageFormattingPrompt('', 'linux')
    const prPrompt = getPullRequestBodyFormattingPrompt('', 'linux')

    expect(commitPrompt).toContain("cat <<'EOF'")
    expect(prPrompt).toContain("cat <<'EOF'")
    expect(commitPrompt).not.toContain('git commit --file')
    expect(prPrompt).not.toContain('--body-file')
  })

  test('BashTool schema description includes examples', () => {
    const schema = BashTool.inputSchema
    const description = schema.shape.description?.description
    expect(description).toContain('Examples:')
    expect(description).toContain('Input: ls')
    expect(description).toContain("Output: Create directory 'foo'")
  })

  test('BashTool schema matches expected keys', () => {
    const schema = BashTool.inputSchema
    const keys = Object.keys(schema.shape).sort()
    expect(keys).toEqual(
      [
        '_simulatedSedEdit',
        'command',
        'dangerouslyDisableSandbox',
        'description',
        'run_in_background',
        'timeout',
      ].sort(),
    )
  })

  test('BashTool validateInput rejects timeouts above 600000ms', async () => {
    const result = await BashTool.validateInput?.({
      command: 'echo hi',
      timeout: 600_001,
    })

    expect(result?.result).toBe(false)
    expect(result?.message).toContain('Maximum allowed timeout')
  })

  test('TaskOutputTool prompt matches reference wording', async () => {
    const prompt = await TaskOutputTool.prompt()
    expect(prompt).toContain('Task IDs can be found using the /tasks command')
  })

  test('TaskStopTool prompt matches reference wording', async () => {
    const prompt = await TaskStopTool.prompt()
    expect(prompt).toContain('Task IDs can be found using the /tasks command')
  })

  test('TodoWriteTool description matches reference wording', async () => {
    const description = await TodoWriteTool.description()
    expect(description).toContain(
      'Update the todo list for the current session.',
    )
    expect(description).toContain(
      'Always provide both content (imperative) and activeForm',
    )
  })

  test('WebFetchTool description matches reference wording', async () => {
    expect(
      await WebFetchTool.description?.({
        url: 'https://example.com',
        prompt: 'x',
      }),
    ).toBe('The assistant wants to fetch content from example.com')

    expect(await WebFetchTool.description?.({ url: '', prompt: 'x' })).toBe(
      'The assistant wants to fetch content from this URL',
    )
  })
})
