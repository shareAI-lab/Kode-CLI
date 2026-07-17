import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readDurableRun } from '#core/runs'
import {
  resetKodeAgentSessionIdForTests,
  setKodeAgentSessionId,
} from '#protocol/utils/kodeAgentSessionId'

import { finishHeadlessRun, startHeadlessRun } from './headlessRunTelemetry'

describe('headlessRunTelemetry lifecycle', () => {
  const originalConfigDir = process.env.KODE_CONFIG_DIR
  let rootDir: string
  let storageRoot: string

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'kode-headless-run-root-'))
    storageRoot = mkdtempSync(join(tmpdir(), 'kode-headless-run-storage-'))
    process.env.KODE_CONFIG_DIR = rootDir
    setKodeAgentSessionId('headless-telemetry-session')
  })

  afterEach(() => {
    resetKodeAgentSessionIdForTests()
    if (originalConfigDir === undefined) delete process.env.KODE_CONFIG_DIR
    else process.env.KODE_CONFIG_DIR = originalConfigDir
    rmSync(rootDir, { recursive: true, force: true })
    rmSync(storageRoot, { recursive: true, force: true })
  })

  test('start/finish persists completed telemetry and is idempotent', () => {
    const tracker = startHeadlessRun({
      cwd: storageRoot,
      storageRoot,
      inputFormat: 'stream-json',
      outputFormat: 'stream-json',
      promptChars: 0,
      toolCount: 2,
      maxTurns: 3,
    })
    expect(tracker).not.toBeNull()
    const id = tracker!.id

    finishHeadlessRun(tracker, {
      totalCostUsd: 0.5,
      durationMs: 12,
      durationApiMs: 8,
    })
    // Second finish models idle-exit racing a normal exit path.
    finishHeadlessRun(tracker, {
      isError: true,
      resultSubtype: 'error_during_execution',
      error: 'should not overwrite',
    })

    const onDisk = readDurableRun({ id, storageRoot })
    expect(onDisk?.status).toBe('completed')
    expect(onDisk?.telemetry?.mode).toBe('headless')
    expect(onDisk?.telemetry?.toolCount).toBe(2)
    expect(onDisk?.telemetry?.totalCostUsd).toBe(0.5)
    expect(onDisk?.telemetry?.failure).toBeUndefined()

    const raw = JSON.parse(
      readFileSync(join(storageRoot, `${id}.json`), 'utf8'),
    ) as { status: string; telemetry?: { totalCostUsd?: number } }
    expect(raw.status).toBe('completed')
    expect(raw.telemetry?.totalCostUsd).toBe(0.5)
  })

  test('failed outcome writes failure telemetry once', () => {
    const tracker = startHeadlessRun({
      cwd: storageRoot,
      storageRoot,
      inputFormat: 'text',
      outputFormat: 'json',
      promptChars: 4,
      toolCount: 0,
    })
    expect(tracker).not.toBeNull()

    finishHeadlessRun(tracker, {
      resultSubtype: 'error_max_turns',
      numTurns: 2,
    })

    const onDisk = readDurableRun({ id: tracker!.id, storageRoot })
    expect(onDisk?.status).toBe('failed')
    expect(onDisk?.telemetry?.failure?.kind).toBe('turn_limit')
    expect(onDisk?.error).toContain('turn limit')
  })
})
