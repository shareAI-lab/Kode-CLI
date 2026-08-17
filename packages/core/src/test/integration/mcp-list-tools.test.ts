import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { getAllTools } from '#tools'

describe('MCP server (stdio)', () => {
  test('tools/list returns built-in tools in stable order', async () => {
    const repoRoot = process.cwd()
    const configDir = mkdtempSync(join(tmpdir(), 'kode-mcp-test-'))

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['apps/cli/src/dispatch.ts', '--mcp-server'],
      cwd: repoRoot,
      env: {
        NODE_ENV: 'test',
        KODE_CONFIG_DIR: configDir,
      },
      stderr: 'pipe',
    })

    const client = new Client(
      { name: 'kode-test', version: '0.0.0' },
      { capabilities: {} },
    )
    try {
      await client.connect(transport)
      const res = await client.listTools()

      const expected = getAllTools().map(t => t.name)
      const actual = res.tools.map(t => t.name)
      expect(actual).toEqual(expected)

      const bash = res.tools.find(t => t.name === 'Bash')
      expect(bash).toBeDefined()
      expect(bash!.inputSchema && typeof bash!.inputSchema).toBe('object')
    } finally {
      try {
        await client.close()
      } catch {
        /* no-op */
      }
      rmSync(configDir, { recursive: true, force: true })
    }
  }, 20_000)
})
