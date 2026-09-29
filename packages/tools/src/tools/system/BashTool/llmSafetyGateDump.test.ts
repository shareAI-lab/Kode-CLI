import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeGateFailureDump } from './llmSafetyGateDump'

describe('Bash LLM gate failure dump (forensics)', () => {
  test('writes a dump file under errors/bash-llm-gate with key sections', () => {
    const originalCwd = process.cwd()
    const originalConfigDir = process.env.KODE_CONFIG_DIR
    const originalLogRoot = process.env.KODE_LOG_ROOT

    const configRoot = mkdtempSync(join(tmpdir(), 'kode-gate-dump-root-'))
    const projectDir = mkdtempSync(join(tmpdir(), 'kode-gate-dump-proj-'))

    try {
      process.env.KODE_CONFIG_DIR = configRoot
      delete process.env.KODE_LOG_ROOT
      process.chdir(projectDir)

      writeGateFailureDump({
        command: 'echo hi',
        userPrompt: 'run echo',
        description: 'test dump',
        findings: [
          {
            code: 'KODE_TEST',
            severity: 'high',
            category: 'data_loss',
            title: 'Test finding',
            evidence: 'example',
          },
        ],
        input: 'INPUT',
        output: 'OUTPUT',
        error: 'Unable to parse LLM gate verdict',
        errorType: 'invalid_output',
      })

      const projectKey = process.cwd().replace(/[^a-zA-Z0-9]/g, '-')
      const dumpDir = join(configRoot, projectKey, 'errors', 'bash-llm-gate')
      const files = readdirSync(dumpDir).filter(name => name.endsWith('.txt'))
      expect(files.length).toBe(1)

      const body = readFileSync(join(dumpDir, files[0]!), 'utf8')
      expect(body).toContain('=== Bash LLM gate failure ===')
      expect(body).toContain('error: Unable to parse LLM gate verdict')
      expect(body).toContain('errorType: invalid_output')
      expect(body).toContain('--- command ---')
      expect(body).toContain('echo hi')
      expect(body).toContain('--- gate input ---')
      expect(body).toContain('INPUT')
      expect(body).toContain('--- gate output ---')
      expect(body).toContain('OUTPUT')
    } finally {
      process.chdir(originalCwd)
      if (originalConfigDir === undefined) delete process.env.KODE_CONFIG_DIR
      else process.env.KODE_CONFIG_DIR = originalConfigDir
      if (originalLogRoot === undefined) delete process.env.KODE_LOG_ROOT
      else process.env.KODE_LOG_ROOT = originalLogRoot
      rmSync(configRoot, { recursive: true, force: true })
      rmSync(projectDir, { recursive: true, force: true })
    }
  })
})
